const WebSocket = require('ws');

// --- Configuration & Server Setup ---
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// --- In-Memory Game Storage ---
const games = new Map(); // Key: gameId, Value: GameState object
const clients = new Map(); // Key: WebSocket client, Value: { playerId, gameId }

// --- Constants ---
const PlayerColor = {
  Red: 'Red',
  Green: 'Green',
  Blue: 'Blue',
  Yellow: 'Yellow',
};

const PieceState = {
  Home: 'Home',
  Active: 'Active',
  Finished: 'Finished',
};

const GameStatus = {
  Setup: 'Setup',
  Playing: 'Playing',
  Finished: 'Finished',
};

const PLAYER_COLORS_ORDER = [
  PlayerColor.Red,
  PlayerColor.Green,
  PlayerColor.Yellow,
  PlayerColor.Blue,
];

// --- Utility Functions ---
function generateGameId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcast(gameId) {
  const gameState = games.get(gameId);
  if (!gameState) return;

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const info = clients.get(client);
      if (info && info.gameId === gameId) {
        client.send(
          JSON.stringify({ type: 'gameStateUpdate', payload: gameState })
        );
      }
    }
  });
}

function sendError(ws, msg) {
  ws.send(JSON.stringify({ type: 'error', payload: { message: msg } }));
}

function createNewPlayer(playerId, name, color, isHost = false) {
  return {
    id: PLAYER_COLORS_ORDER.indexOf(color),
    playerId,
    name,
    color,
    type: 'Human',
    pieces: Array.from({ length: 4 }).map((_, i) => ({
      id: PLAYER_COLORS_ORDER.indexOf(color) * 4 + i,
      color,
      state: PieceState.Home,
      position: -1,
    })),
    hasFinished: false,
    inactiveTurns: 0,
    isRemoved: false,
    isHost,
  };
}

function advanceTurn(gameState) {
  if (gameState.players.length === 0) return;

  let nextIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  while (gameState.players[nextIndex].isRemoved) {
    nextIndex = (nextIndex + 1) % gameState.players.length;
  }

  gameState.currentPlayerIndex = nextIndex;
  gameState.currentTurnPlayerId = gameState.players[nextIndex].playerId;
  gameState.diceValue = null;
  gameState.isRolling = false;
  gameState.message = `${gameState.players[nextIndex].name}'s turn.`;
  gameState.turnTimeLeft = 30;
}

// --- WebSocket Logic ---
wss.on('connection', ws => {
  console.log('Client connected');

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('Invalid message:', raw);
      return;
    }

    const { type, payload } = msg;
    const { gameId, playerId, playerName, text } = payload || {};
    const game = games.get(gameId);

    switch (type) {
      case 'createGame': {
        const newId = generateGameId();
        clients.set(ws, { playerId, gameId: newId });

        const host = createNewPlayer(playerId, playerName, PLAYER_COLORS_ORDER[0], true);
        const state = {
          gameId: newId,
          hostId: playerId,
          players: [host],
          playerOrder: PLAYER_COLORS_ORDER,
          currentPlayerIndex: 0,
          diceValue: null,
          gameStatus: GameStatus.Setup,
          winner: null,
          message: 'Waiting for players to join...',
          movablePieces: [],
          isAnimating: false,
          isRolling: false,
          turnTimeLeft: 30,
          chatMessages: [],
        };

        games.set(newId, state);
        ws.send(JSON.stringify({ type: 'gameStateUpdate', payload: state }));
        break;
      }

      case 'joinGame': {
        if (!game) return sendError(ws, `Game ${gameId} not found.`);
        if (game.players.length >= 4)
          return sendError(ws, 'This game is full.');

        if (game.players.some(p => p.playerId === playerId)) {
          clients.set(ws, { playerId, gameId });
          broadcast(gameId);
          return;
        }

        const color = PLAYER_COLORS_ORDER[game.players.length];
        const newPlayer = createNewPlayer(playerId, playerName, color);
        game.players.push(newPlayer);
        clients.set(ws, { playerId, gameId });
        broadcast(gameId);
        break;
      }

      case 'startGame': {
        if (!game || game.hostId !== playerId)
          return sendError(ws, 'Only host can start.');
        game.gameStatus = GameStatus.Playing;
        game.currentPlayerIndex = 0;
        game.currentTurnPlayerId = game.players[0].playerId;
        game.message = `${game.players[0].name}'s turn.`;
        broadcast(gameId);
        break;
      }

      case 'rollDice': {
        if (!game || game.currentTurnPlayerId !== playerId)
          return sendError(ws, "It's not your turn!");
        if (game.isRolling || game.diceValue !== null) return;

        game.isRolling = true;
        broadcast(gameId);

        setTimeout(() => {
          const diceValue = Math.floor(Math.random() * 6) + 1;
          game.diceValue = diceValue;
          game.isRolling = false;
          game.message = `${game.players[game.currentPlayerIndex].name} rolled a ${diceValue}.`;
          broadcast(gameId);

          setTimeout(() => {
            advanceTurn(game);
            broadcast(gameId);
          }, 1500);
        }, 1000);
        break;
      }

      case 'chatMessage': {
        if (!game) return;
        const player = game.players.find(p => p.playerId === playerId);
        if (player) {
          const msgObj = {
            id: `${Date.now()}`,
            playerId,
            name: player.name,
            color: player.color,
            text,
            timestamp: Date.now(),
          };
          game.chatMessages.push(msgObj);
          broadcast(gameId);
        }
        break;
      }

      case 'leaveGame': {
        if (!game) return;
        const i = game.players.findIndex(p => p.playerId === playerId);
        if (i > -1) {
          game.players[i].isRemoved = true;
          game.message = `${game.players[i].name} left.`;
          if (game.currentTurnPlayerId === playerId) advanceTurn(game);
          broadcast(gameId);
        }
        clients.delete(ws);
        break;
      }

      case 'resetGame':
      case 'forceSync': {
        if (!game || game.hostId !== playerId) return;
        advanceTurn(game);
        broadcast(gameId);
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    const info = clients.get(ws);
    if (!info) return;
    const { gameId, playerId } = info;
    const game = games.get(gameId);
    if (game) {
      const player = game.players.find(p => p.playerId === playerId);
      if (player) {
        player.isRemoved = true;
        game.message = `${player.name} disconnected.`;
        if (game.currentTurnPlayerId === playerId) advanceTurn(game);
        broadcast(gameId);
      }
    }
    clients.delete(ws);
  });

  ws.on('error', err => console.error('WebSocket error:', err));
});

console.log(`✅ WebSocket server started on ws://localhost:${PORT}`);
