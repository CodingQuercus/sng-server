require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT

const userList = {};

const gamesList = {};

//const wordsList = ['Snake', 'Boat', 'Apple', 'House', 'Mountain', 'Sun', 'Dog', 'Cat', 'Swing', 'Flower'];

const wordsList = ['Box']

const secretWordsList = {};

app.use(express.json());

// genererar en alfanumerisk kod med längd 6
const generateGameCode = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

// välja en slumpmässig spelare och ord
const selectRandomPlayerAndWord = (gameId) => {
    const players = gamesList[gameId] || [];
    const randomPlayer = players[Math.floor(Math.random() * players.length)];
    const randomWord = wordsList[Math.floor(Math.random() * wordsList.length)];
    return { randomPlayer, randomWord };
};

// vid anslutningar
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('createGame', ({ nickname, size, mapLat, mapLon, timeInMinutes, selectedRounds }) => {
        const gameCode = generateGameCode();

        userList[socket.id] = { id: socket.id, nickname, gameCode, role: 'host' };

        gamesList[gameCode] = [{
            id: socket.id,
            size, latitude: mapLat, longitude: mapLon,
            nickname, role: 'host',
            time: timeInMinutes, score: 0,
            rounds: selectedRounds, currentRound: 1
        }];

        console.log(`User ${nickname} (${socket.id}) created game ${gameCode}`);
        socket.join(gameCode);
        socket.emit('gameCreated', { gameCode, nickname, role: 'host' });
        io.to(gameCode).emit('playerList', gamesList[gameCode]);
    });

    socket.on('startGame', (gameCode, commando) => {
        if (commando !== "Start") return;

        const gamePlayers = gamesList[gameCode];
        if (!gamePlayers) {
            socket.emit('error', 'Game not found');
            return;
        }

        const host = gamePlayers.find(player => player.role === 'host');
        if (!host || host.id !== socket.id) {
            socket.emit('error', 'Error: only host can start the game');
            return;
        }

        // Rensa gamla gameroles innan ny runda
        gamePlayers.forEach(p => { p.gamerole = null; });

        io.to(gameCode).emit('start', gamePlayers);

        const { randomPlayer, randomWord } = selectRandomPlayerAndWord(gameCode);
        randomPlayer.gamerole = 'drawer';
        secretWordsList[gameCode] = randomWord;

        io.to(randomPlayer.id).emit('drawingTurn', {
            playerId: randomPlayer.id,
            nickname: randomPlayer.nickname,
            size: host.size,
            latitude: host.latitude,
            longitude: host.longitude,
            gamerole: 'drawer',
            word: randomWord,
            roundTime: host.time,
        });

        gamePlayers.forEach(player => {
            if (player.id !== randomPlayer.id) {
                io.to(player.id).emit('guessingTurn', {
                    playerId: player.id,
                    size: host.size,
                    latitude: host.latitude,
                    longitude: host.longitude,
                    gamerole: 'guesser',
                    roundTime: host.time,
                });
            }
        });
    });

    // för att joina en lobby
    socket.on('joinGame', ({ gameCode, nickname }) => {
        if (!gamesList[gameCode]) {
            socket.emit('error', 'Game not found');
            return;
        }

        const existingPlayer = gamesList[gameCode].find(player => player.nickname === nickname);
        if (!existingPlayer) {
            gamesList[gameCode].push({ id: socket.id, nickname, role: 'player', score: 0 });
        } else {
            existingPlayer.id = socket.id;
        }

        socket.join(gameCode);
        console.log(`User ${nickname} (${socket.id}) joined game: ${gameCode}`);
        io.to(gameCode).emit('playerList', gamesList[gameCode]);
    });

    socket.on('fetchPlayers', (gameCode) => {
        if (gamesList[gameCode]) {
            socket.emit('playerList', gamesList[gameCode]);
        } else {
            socket.emit('error', 'Game not found');
        }
    });

    socket.on('leaveGame', ({ gameCode }) => {
        if (!gamesList[gameCode]) {
            socket.emit('error', 'Game not found');
            return;
        }

        gamesList[gameCode] = gamesList[gameCode].filter(player => player.id !== socket.id);

        if (gamesList[gameCode].length === 0) {
            delete gamesList[gameCode];
        } else {
            io.to(gameCode).emit('playerList', gamesList[gameCode]);
        }

        socket.emit('leaveSuccess', { message: `You have left the game ${gameCode}.` });
    });

    // skicka ut data till alla klienter om ritningen
    socket.on('drawing', ({ gameCode, drawingData }) => {
        socket.to(gameCode).emit('draw', drawingData);
    });

    // skicka ut data till alla klienter om ritningen
    socket.on('currentLine', ({ gameCode, currentLine }) => {
        socket.to(gameCode).emit('currentLine', currentLine);
    });

    socket.on('timeOut', ({ gameCode }) => {
        if (!gamesList[gameCode]) return;

        const secretWord = secretWordsList[gameCode];
        if (!secretWord) return;

        const host = gamesList[gameCode].find(p => p.role === 'host');
        if (host) host.currentRound += 1;

        io.to(gameCode).emit('endGame', {
            winner: null,
            message: `Time's up! The word was "${secretWord}"`,
        });

        delete secretWordsList[gameCode];
    });

    socket.on('message', ({ gameCode, nickname, message }) => {
        const secretWord = secretWordsList[gameCode];
        if (!secretWord) {
            console.log('Error: No secret word for this game');
            return;
        }

        if (message.toUpperCase() === secretWord.toUpperCase()) {
            const host = gamesList[gameCode].find(player => player.role === 'host');
            const player = gamesList[gameCode].find(player => player.nickname === nickname);
            const drawer = gamesList[gameCode].find(player => player.gamerole === 'drawer');

            if (player) player.score += 10;
            if (drawer) drawer.score += 5;
            if (host) host.currentRound += 1;

            io.to(gameCode).emit('endGame', {
                winner: nickname,
                message: `${nickname} guessed the correct word! It was "${secretWord}"`,
            });

            delete secretWordsList[gameCode];
        } else {
            io.to(gameCode).emit('message', { nickname, message, gameCode });
        }
    });

    // Vid disconnect av klient
    socket.on('disconnect', () => {
        console.log('A user disconnected:', socket.id);
        delete userList[socket.id];

        for (const gameId in gamesList) {
            const wasInGame = gamesList[gameId].some(p => p.id === socket.id);
            if (wasInGame) {
                gamesList[gameId] = gamesList[gameId].filter(p => p.id !== socket.id);

                if (gamesList[gameId].length === 0) {
                    delete gamesList[gameId];
                } else {
                    io.to(gameId).emit('playerLeft', { message: 'A player disconnected' });
                    io.to(gameId).emit('playerList', gamesList[gameId]);
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Servern kör på port: ${PORT}`);
});
