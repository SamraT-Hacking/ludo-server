const WebSocket = require('ws');

// --- Configuration & Server Setup ---
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// --- In-Memory Game Storage ---
// We store all game states and client connections right here in memory.
// This is simple and fast, but will be cleared if the server restarts.
const games = new Map(); // Key: gameId, Value: GameState object
const clients = new Map(); // Key: WebSocket client, Value: { playerId, gameId }

// --- Constants (should match your frontend types.ts) ---
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

const PLAYER_COLORS_ORDER = [PlayerColor.Red, PlayerColor.Green, PlayerColor.Yellow, PlayerColor.Blue];

// --- Utility Functions ---

/**
 * Generates a random, 6-character uppercase string for a game ID.
 */
function generateGameId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * Sends a message to every client connected to a specific game room.
 * @param {string} gameId The ID of the game room.
 * @param {object} message The message object to send.
 */
function broadcast(gameId, message) {
  const gameState = games.get(gameId);
  if (!gameState) return;

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const clientInfo = clients.get(client);
      if (clientInfo && clientInfo.gameId === gameId) {
        // Send the entire updated game state to every player in the room.
        client.send(JSON.stringify({ type: 'gameStateUpdate', payload: gameState }));
      }
    }
  });
}

/**
 * Sends an error message back to a single client.
 * @param {WebSocket} ws The client's WebSocket connection.
 * @param {string} errorMessage The error message text.
 */
function sendError(ws, errorMessage) {
  ws.send(JSON.stringify({ type: 'error', payload: { message: errorMessage } }));
}

/**
 * Creates the initial structure for a new player.
 */
function createNewPlayer(playerId, playerName, color, isHost = false) {
  return {
    id: PLAYER_COLORS_ORDER.indexOf(color),
    playerId,
    name: playerName,
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

/**
 * Advances the turn to the next active player.
 * @param {object} gameState The current game state.
 */
function advanceTurn(gameState) {
  if (gameState.players.length === 0) return;
  
  let nextIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  // Skip over players who have left
  while (gameState.players[nextIndex].isRemoved) {
      nextIndex = (nextIndex + 1) % gameState.players.length;
  }
  
  gameState.currentPlayerIndex = nextIndex;
  gameState.currentTurnPlayerId = gameState.players[nextIndex].playerId;
  gameState.diceValue = null;
  gameState.isRolling = false;
  gameState.message = `${gameState.players[nextIndex].name}'s turn.`;
  gameState.turnTimeLeft = 30; // Reset timer
}

// --- WebSocket Event Handlers ---

wss.on('connection', ws => {
  console.log('Client connected');

  ws.on('message', messageString => {
    let message;
    try {
      message = JSON.parse(messageString);
      console.log('Received:', message);
    } catch (error) {
      console.error('Failed to parse message:', messageString);
      return;
    }

    const { type, payload } = message;
    const { gameId, playerId, playerName, text } = payload || {};
    const game = games.get(gameId);

    switch (type) {
      case 'createGame': {
        const newGameId = generateGameId();
        clients.set(ws, { playerId, gameId: newGameId });
        
        const hostPlayer = createNewPlayer(playerId, playerName, PLAYER_COLORS_ORDER[0], true);

        const newGameState = {
          gameId: newGameId,
          hostId: playerId,
          players: [hostPlayer],
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
        games.set(newGameId, newGameState);
        ws.send(JSON.stringify({ type: 'gameStateUpdate', payload: newGameState }));
        break;
      }
      
      case 'joinGame': {
        if (!game) {
          sendError(ws, `Game with ID ${gameId} not found.`);
          return;
        }
        if (game.players.length >= 4) {
          sendError(ws, 'This game is already full.');
          return;
        }
        if (game.players.some(p => p.playerId === playerId)) {
          // Reconnecting player logic could go here, but for now just broadcast.
           clients.set(ws, { playerId, gameId });
           broadcast(gameId);
          return;
        }

        clients.set(ws, { playerId, gameId });
        const newPlayerColor = PLAYER_COLORS_ORDER[game.players.length];
        const newPlayer = createNewPlayer(playerId, playerName, newPlayerColor);
        game.players.push(newPlayer);
        
        broadcast(gameId);
        break;
      }

      case 'startGame': {
          if (!game || game.hostId !== playerId) {
              sendError(ws, "Only the host can start the game.");
              return;
          }
          game.gameStatus = GameStatus.Playing;
          game.currentPlayerIndex = 0;
          game.currentTurnPlayerId = game.players[0].playerId;
          game.message = `${game.players[0].name}'s turn.`;
          broadcast(gameId);
          break;
      }

      case 'rollDice': {
        if (!game || game.currentTurnPlayerId !== playerId) {
            sendError(ws, "It's not your turn!");
            return;
        }
        if (game.isRolling || game.diceValue !== null) {
            return; // Prevent multiple rolls
        }
        
        game.isRolling = true;
        broadcast(gameId); // Show rolling animation on all clients

        setTimeout(() => {
            const diceValue = Math.floor(Math.random() * 6) + 1;
            game.diceValue = diceValue;
            game.isRolling = false;
            game.message = `${game.players[game.currentPlayerIndex].name} rolled a ${diceValue}.`;
            // NOTE: In a real game, you would calculate movable pieces here.
            // For now, we'll just pass the turn after a short delay.
            broadcast(gameId);

            // Automatically pass the turn after showing the dice result
            setTimeout(() => {
                advanceTurn(game);
                broadcast(gameId);
            }, 1500); // 1.5 second delay to see the dice result

        }, 1000); // 1 second rolling animation
        break;
      }
      
      case 'chatMessage': {
        if (!game) return;
        const player = game.players.find(p => p.playerId === playerId);
        if (player) {
            const chatMessage = {
                id: `${Date.now()}`,
                playerId,
                name: player.name,
                color: player.color,
                text,
                timestamp: Date.now()
            };
            game.chatMessages.push(chatMessage);
            broadcast(gameId);
        }
        break;
      }
      
      case 'leaveGame': {
          if (!game) return;
          const playerIndex = game.players.findIndex(p => p.playerId === playerId);
          if (playerIndex > -1) {
              game.players[playerIndex].isRemoved = true;
              game.message = `${game.players[playerIndex].name} has left the game.`;
              // If it was their turn, advance to the next player
              if (game.currentTurnPlayerId === playerId) {
                  advanceTurn(game);
              }
              broadcast(gameId);
          }
          clients.delete(ws);
          break;
      }

      case 'resetGame': // Host can restart the game
      case 'forceSync': // Host can fix a stuck turn
      {
          if(!game || game.hostId !== playerId) return;
          advanceTurn(game);
          broadcast(gameId);
          break;
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      const { gameId, playerId } = clientInfo;
      const game = games.get(gameId);
      if (game) {
        const player = game.players.find(p => p.playerId === playerId);
        if (player) {
          player.isRemoved = true;
          game.message = `${player.name} has disconnected.`;
           // If it was their turn, advance to the next player
           if (game.currentTurnPlayerId === playerId) {
              advanceTurn(game);
           }
          broadcast(gameId);
        }
      }
      clients.delete(ws);
    }
  });
  
  ws.on('error', (error) => {
      console.error('WebSocket error:', error);
  });
});

console.log(`WebSocket server started on ws://localhost:${PORT}`);