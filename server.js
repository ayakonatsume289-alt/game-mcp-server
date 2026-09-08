const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const { GomokuGame } = require('./games/gomoku');

const app = express();
app.use(express.json());

// ============================================================
// Data Storage (in-memory, will persist across requests)
// ============================================================
const games = new Map();       // gameId -> game instance
const gameHistory = [];        // finished games

// ============================================================
// Web Frontend Routes
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// REST API for Web Frontend
// ============================================================

// Create a new game
app.post('/api/games', (req, res) => {
  const { gameType = 'gomoku', players } = req.body;
  if (!players || !Array.isArray(players) || players.length < 2) {
    return res.status(400).json({ error: '需要至少两名玩家' });
  }

  const gameId = uuidv4().slice(0, 8);
  let game;

  if (gameType === 'gomoku') {
    game = new GomokuGame(gameId, players);
  } else {
    return res.status(400).json({ error: `不支持的游戏类型: ${gameType}` });
  }

  games.set(gameId, game);
  res.json({ gameId, message: '游戏已创建', game: game.getPublicState() });
});

// Get game state (for web frontend, shows full board)
app.get('/api/games/:gameId', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: '游戏不存在' });
  res.json(game.getPublicState());
});

// Make a move (for web frontend)
app.post('/api/games/:gameId/move', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ error: '游戏不存在' });

  const { player, ...moveData } = req.body;
  if (!player) return res.status(400).json({ error: '需要指定玩家' });

  const result = game.makeMove(player, moveData);
  if (result.error) return res.status(400).json(result);

  // If game is finished, archive it
  if (game.status === 'finished') {
    gameHistory.push(game.getFullHistory());
  }

  res.json(result);
});

// List all games
app.get('/api/games', (req, res) => {
  const active = [];
  games.forEach((game, id) => {
    active.push({ gameId: id, ...game.getPublicState() });
  });
  res.json({ active, history: gameHistory });
});

// ============================================================
// MCP SSE Transport
// ============================================================
const mcpSessions = new Map();

// SSE endpoint - client connects here
app.get('/mcp', (req, res) => {
  const sessionId = uuidv4();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Send the endpoint URL for this session
  res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`);

  // Store session
  mcpSessions.set(sessionId, { res, createdAt: Date.now() });

  // Heartbeat
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    mcpSessions.delete(sessionId);
  });
});

// MCP message endpoint
app.post('/mcp/messages', (req, res) => {
  const { sessionId } = req.query;
  const session = mcpSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const message = req.body;
  const response = handleMcpMessage(message, sessionId);

  // Send response via SSE
  session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);

  res.status(202).json({ status: 'accepted' });
});

// ============================================================
// MCP Protocol Handler
// ============================================================
function handleMcpMessage(message, sessionId) {
  const { method, id, params } = message;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'game-mcp-server', version: '0.1.0' }
        }
      };

    case 'notifications/initialized':
      return null; // No response needed

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'create_game',
              description: '创建新游戏对局。目前支持五子棋(gomoku)。',
              inputSchema: {
                type: 'object',
                properties: {
                  game_type: { type: 'string', description: '游戏类型: gomoku', default: 'gomoku' },
                  players: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '玩家名称列表，如 ["菲菲", "夜声"]'
                  }
                },
                required: ['players']
              }
            },
            {
              name: 'get_game_state',
              description: '查看当前游戏局面。对于五子棋，返回完整棋盘。',
              inputSchema: {
                type: 'object',
                properties: {
                  game_id: { type: 'string', description: '游戏ID' },
                  player: { type: 'string', description: '你的玩家名称（用于信息隔离）' }
                },
                required: ['game_id']
              }
            },
            {
              name: 'make_move',
              description: '执行操作。五子棋: 在指定位置落子。坐标从0开始，如 row=7, col=7 表示棋盘中心。',
              inputSchema: {
                type: 'object',
                properties: {
                  game_id: { type: 'string', description: '游戏ID' },
                  player: { type: 'string', description: '你的玩家名称' },
                  row: { type: 'integer', description: '行坐标 (0-14)' },
                  col: { type: 'integer', description: '列坐标 (0-14)' }
                },
                required: ['game_id', 'player', 'row', 'col']
              }
            },
            {
              name: 'list_games',
              description: '查看所有进行中和已结束的游戏。',
              inputSchema: { type: 'object', properties: {} }
            },
            {
              name: 'get_game_history',
              description: '查看某局游戏的完整记录。',
              inputSchema: {
                type: 'object',
                properties: {
                  game_id: { type: 'string', description: '游戏ID' }
                },
                required: ['game_id']
              }
            }
          ]
        }
      };

    case 'tools/call':
      return handleToolCall(id, params);

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` }
      };
  }
}

function handleToolCall(id, params) {
  const { name, arguments: args } = params;

  try {
    let result;

    switch (name) {
      case 'create_game': {
        const { game_type = 'gomoku', players } = args;
        if (!players || players.length < 2) {
          throw new Error('需要至少两名玩家');
        }
        const gameId = uuidv4().slice(0, 8);
        let game;
        if (game_type === 'gomoku') {
          game = new GomokuGame(gameId, players);
        } else {
          throw new Error(`不支持的游戏类型: ${game_type}`);
        }
        games.set(gameId, game);
        result = `游戏已创建！\n游戏ID: ${gameId}\n类型: ${game_type}\n玩家: ${players.join(' vs ')}\n\n${game.getBoardString()}\n\n轮到 ${game.currentPlayer} 落子`;
        break;
      }

      case 'get_game_state': {
        const game = games.get(args.game_id);
        if (!game) throw new Error('游戏不存在');
        const state = game.getStateForPlayer(args.player);
        result = state;
        break;
      }

      case 'make_move': {
        const game = games.get(args.game_id);
        if (!game) throw new Error('游戏不存在');
        const moveResult = game.makeMove(args.player, { row: args.row, col: args.col });
        if (moveResult.error) throw new Error(moveResult.error);
        // Archive if finished
        if (game.status === 'finished') {
          gameHistory.push(game.getFullHistory());
        }
        result = moveResult.message + '\n\n' + game.getBoardString();
        if (game.status === 'playing') {
          result += `\n\n轮到 ${game.currentPlayer} 落子`;
        }
        break;
      }

      case 'list_games': {
        const activeList = [];
        games.forEach((game, gid) => {
          activeList.push(`[${gid}] ${game.gameType} - ${game.players.join(' vs ')} - ${game.status}`);
        });
        const histList = gameHistory.map((h, i) =>
          `[${h.gameId}] ${h.gameType} - ${h.players.join(' vs ')} - 胜者: ${h.winner || '平局'}`
        );
        result = '--- 进行中的游戏 ---\n' +
          (activeList.length ? activeList.join('\n') : '无') +
          '\n\n--- 已结束的游戏 ---\n' +
          (histList.length ? histList.join('\n') : '无');
        break;
      }

      case 'get_game_history': {
        const hist = gameHistory.find(h => h.gameId === args.game_id);
        const activeGame = games.get(args.game_id);
        if (hist) {
          result = JSON.stringify(hist, null, 2);
        } else if (activeGame) {
          result = JSON.stringify(activeGame.getFullHistory(), null, 2);
        } else {
          throw new Error('游戏不存在');
        }
        break;
      }

      default:
        throw new Error(`未知工具: ${name}`);
    }

    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] }
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `错误: ${err.message}` }], isError: true }
    };
  }
}

// ============================================================
// Start Server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Game MCP Server running on port ${PORT}`);
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`MCP SSE: http://localhost:${PORT}/mcp`);
});
