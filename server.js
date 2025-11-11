const WebSocket = require('ws');

// --- Configuration & Server Setup ---
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

// --- In-Memory Game Storage ---
const games = new Map(); // Key: gameId, Value: GameState object
const clients = new Map(); // Key: WebSocket client, Value: { playerId, gameId }

// --- Constants (should match your frontend types.ts) ---
const PlayerColor = { Red: 'Red', Green: 'Green', Blue: 'Blue', Yellow: 'Yellow' };
const PieceState = { Home: 'Home', Active: 'Active', Finished: 'Finished' };
const GameStatus = { Setup: 'Setup', Playing: 'Playing', Finished: 'Finished' };
const PLAYER_COLORS_ORDER = [PlayerColor.Red, PlayerColor.Green, PlayerColor.Yellow, PlayerColor.Blue];
const TOTAL_PATH_LENGTH = 52;
const HOME_STRETCH_LENGTH = 6;
const FINISH_POSITION_START = 100;
const SAFE_SPOTS = [1, 9, 14, 22, 27, 35, 40, 48];
const START_POSITIONS = { Green: 1, Red: 14, Yellow: 40, Blue: 27 };
const PRE_HOME_POSITIONS = { Green: 51, Red: 12, Yellow: 38, Blue: 25 };


// --- Utility Functions ---

function generateGameId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcast(gameId, updatedGameState) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const clientInfo = clients.get(client);
      if (clientInfo && clientInfo.gameId === gameId) {
        client.send(JSON.stringify({ type: 'gameStateUpdate', payload: updatedGameState }));
      }
    }
  });
}

function sendError(ws, errorMessage) {
  ws.send(JSON.stringify({ type: 'error', payload: { message: errorMessage } }));
}

function createNewPlayer(playerId, playerName, color, isHost = false) {
    const playerIndex = PLAYER_COLORS_ORDER.indexOf(color);
    return {
        id: playerIndex,
        playerId,
        name: playerName,
        color,
        type: 'Human',
        pieces: Array.from({ length: 4 }).map((_, i) => ({
            id: playerIndex * 4 + i,
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
  gameState.movablePieces = [];
  gameState.message = `${gameState.players[nextIndex].name}'s turn.`;
  gameState.turnTimeLeft = 30;
}

// --- Core Game Logic ---

function getNewPosition(piece, diceValue) {
    if (piece.state === PieceState.Home && diceValue === 6) {
        return { position: START_POSITIONS[piece.color], state: PieceState.Active };
    }

    if (piece.state === PieceState.Active) {
        if (piece.position >= FINISH_POSITION_START) {
            const homeStretchPos = piece.position - FINISH_POSITION_START;
            const newHomeStretchPos = homeStretchPos + diceValue;
            if (newHomeStretchPos < HOME_STRETCH_LENGTH) {
                const newState = (newHomeStretchPos === HOME_STRETCH_LENGTH - 1) ? PieceState.Finished : PieceState.Active;
                return { position: FINISH_POSITION_START + newHomeStretchPos, state: newState };
            }
        } else {
            const preHomePos = PRE_HOME_POSITIONS[piece.color];
            const distToPreHome = (preHomePos - piece.position + TOTAL_PATH_LENGTH) % TOTAL_PATH_LENGTH;
            if (diceValue > distToPreHome) {
                const homeStretchPos = diceValue - distToPreHome - 1;
                if (homeStretchPos < HOME_STRETCH_LENGTH) {
                    const newPos = FINISH_POSITION_START + homeStretchPos;
                    const newState = (homeStretchPos === HOME_STRETCH_LENGTH - 1) ? PieceState.Finished : PieceState.Active;
                    return { position: newPos, state: newState };
                }
            } else {
                const newPosRaw = (piece.position + diceValue);
                const newPos = newPosRaw > TOTAL_PATH_LENGTH ? newPosRaw % TOTAL_PATH_LENGTH : newPosRaw;
                return { position: newPos, state: PieceState.Active };
            }
        }
    }
    return { position: piece.position, state: piece.state }; // Invalid move
}

function calculateMovablePieces(player, diceValue, players) {
    const movable = [];
    for (const piece of player.pieces) {
        if (piece.state === PieceState.Finished) continue;

        const { position: newPos, state: newState } = getNewPosition(piece, diceValue);
        if (newPos === piece.position && newState === piece.state) continue; // Not a valid move

        const ownPiecesAtDestination = player.pieces
            .filter(p => p.state === PieceState.Active && p.position === newPos)
            .length;
        
        // Cannot land on a spot if it's occupied by two of your own pieces (blockade)
        if (ownPiecesAtDestination >= 2) {
            continue;
        }

        movable.push(piece.id);
    }
    return movable;
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
        console.error('Failed to parse message:', messageString); return;
    }

    const { type, payload } = message;
    const { gameId, playerId, playerName, pieceId } = payload || {};
    const game = games.get(gameId);

    switch (type) {
        case 'createGame': {
            const newGameId = generateGameId();
            clients.set(ws, { playerId, gameId: newGameId });
            const hostPlayer = createNewPlayer(playerId, playerName, PLAYER_COLORS_ORDER[0], true);
            const newGameState = { gameId: newGameId, hostId: playerId, players: [hostPlayer], playerOrder: PLAYER_COLORS_ORDER, currentPlayerIndex: 0, diceValue: null, gameStatus: GameStatus.Setup, winner: null, message: 'Waiting for players...', movablePieces: [], isAnimating: false, isRolling: false, turnTimeLeft: 30, chatMessages: [] };
            games.set(newGameId, newGameState);
            ws.send(JSON.stringify({ type: 'gameStateUpdate', payload: newGameState }));
            break;
        }

        case 'joinGame': {
            if (!game) { sendError(ws, `Game ${gameId} not found.`); return; }
            if (game.players.length >= 4) { sendError(ws, 'This game is full.'); return; }
            if (game.players.some(p => p.playerId === playerId)) {
                clients.set(ws, { playerId, gameId });
                broadcast(gameId, game); return;
            }
            clients.set(ws, { playerId, gameId });
            const newPlayerColor = PLAYER_COLORS_ORDER[game.players.length];
            const newPlayer = createNewPlayer(playerId, playerName, newPlayerColor);
            game.players.push(newPlayer);
            broadcast(gameId, game);
            break;
        }

        case 'startGame': {
            if (!game || game.hostId !== playerId) { sendError(ws, "Only the host can start."); return; }
            game.gameStatus = GameStatus.Playing;
            game.currentPlayerIndex = 0;
            game.currentTurnPlayerId = game.players[0].playerId;
            game.message = `${game.players[0].name}'s turn.`;
            broadcast(gameId, game);
            break;
        }

        case 'rollDice': {
            if (!game || game.currentTurnPlayerId !== playerId || game.diceValue !== null) return;
            game.isRolling = true;
            broadcast(gameId, game);

            setTimeout(() => {
                const diceValue = Math.floor(Math.random() * 6) + 1;
                game.diceValue = diceValue;
                game.isRolling = false;
                const currentPlayer = game.players[game.currentPlayerIndex];
                
                const movablePieces = calculateMovablePieces(currentPlayer, diceValue, game.players);
                game.movablePieces = movablePieces;

                if (movablePieces.length === 0) {
                    game.message = `${currentPlayer.name} rolled a ${diceValue}, but has no moves.`;
                    broadcast(gameId, game);
                    setTimeout(() => {
                        advanceTurn(game);
                        broadcast(gameId, game);
                    }, 1500);
                } else {
                    game.message = `${currentPlayer.name} rolled a ${diceValue}. Move a piece.`;
                    broadcast(gameId, game);
                }
            }, 1000);
            break;
        }

        case 'movePiece': {
            if (!game || game.currentTurnPlayerId !== playerId || !game.movablePieces.includes(pieceId)) return;
            
            const player = game.players[game.currentPlayerIndex];
            const piece = player.pieces.find(p => p.id === pieceId);
            if (!piece) return;

            const { position: newPos, state: newState } = getNewPosition(piece, game.diceValue);
            piece.position = newPos;
            piece.state = newState;

            let capturedAPiece = false;
            if (newState === PieceState.Active && !SAFE_SPOTS.includes(newPos)) {
                game.players.forEach(p => {
                    if (p.playerId !== playerId) {
                        p.pieces.forEach(oppPiece => {
                            if (oppPiece.position === newPos) {
                                oppPiece.state = PieceState.Home;
                                oppPiece.position = -1;
                                capturedAPiece = true;
                            }
                        });
                    }
                });
            }
            
            player.hasFinished = player.pieces.every(p => p.state === PieceState.Finished);
            if(player.hasFinished) {
                game.gameStatus = GameStatus.Finished;
                game.winner = player;
                game.message = `${player.name} has won the game!`;
                broadcast(gameId, game);
                return;
            }

            if (game.diceValue === 6 || capturedAPiece) {
                game.diceValue = null;
                game.movablePieces = [];
                game.message = `${player.name} gets another turn!`;
            } else {
                advanceTurn(game);
            }
            broadcast(gameId, game);
            break;
        }

        case 'chatMessage': {
            if (!game) return;
            const player = game.players.find(p => p.playerId === playerId);
            if (player) {
                game.chatMessages.push({ id: `${Date.now()}`, playerId, name: player.name, color: player.color, text: payload.text, timestamp: Date.now() });
                broadcast(gameId, game);
            }
            break;
        }

        // Add other cases like leaveGame, forceSync etc. here if needed
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
                if (game.currentTurnPlayerId === playerId) {
                    advanceTurn(game);
                }
                broadcast(gameId, game);
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
