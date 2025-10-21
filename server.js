const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Game State
const gameState = {
  players: new Map(),
  rooms: new Map(),
  games: new Map(),
  killCooldowns: new Map(),
  meetingDuration: 90,
  gameTimer: null,
  timeRemaining: 300 // 5 minutes in seconds
};

// Player tasks
const CREWMATE_TASKS = [
  { id: 'network', name: 'Network Security Log', duration: 120 },
  { id: 'phishing', name: 'Phishing Email Sort', duration: 180 },
  { id: 'firewall', name: 'Firewall Construction', duration: 150 },
  { id: 'encryption', name: 'Data Encryption', duration: 100 },
  { id: 'backup', name: 'System Backup', duration: 90 }
];

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/impostor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'impostor.html'));
});

app.get('/crewmate', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'crewmate.html'));
});

app.get('/voting', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'voting.html'));
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Player joins lobby
  socket.on('join-lobby', (playerData) => {
    const player = {
      id: socket.id,
      name: playerData.name,
      role: null,
      room: 'main',
      isAlive: true,
      tasks: [],
      sabotageCount: 0,
      color: getRandomColor(),
      taskProgress: {
        tasksCompleted: 0,
        task1: { completed: false, data: null },
        task2: { completed: false, data: null },
        task3: { completed: false, data: null }
      },
      vote: null
    };

    gameState.players.set(socket.id, player);
    socket.join('main');

    // Assign random tasks
    player.tasks = getRandomTasks(3);
    
    // Send player list to everyone
    broadcastPlayerList();
    
    console.log(`Player ${playerData.name} joined lobby`);
  });

  // Start game (NO PLAYER COUNT REQUIREMENT)
  socket.on('start-game', () => {
    const players = Array.from(gameState.players.values());
    
    if (players.length >= 1) {
      // Assign roles - 1 impostor if 2+ players, otherwise all crewmates
      const impostorCount = players.length >= 2 ? 1 : 0;
      const impostorIndices = [];
      
      if (impostorCount > 0) {
        while (impostorIndices.length < impostorCount) {
          const randomIndex = Math.floor(Math.random() * players.length);
          if (!impostorIndices.includes(randomIndex)) {
            impostorIndices.push(randomIndex);
          }
        }
      }

      players.forEach((player, index) => {
        player.role = impostorIndices.includes(index) ? 'impostor' : 'crewmate';
        player.isAlive = true;
        player.sabotageCount = 0;
        player.vote = null;
        player.taskProgress = {
          tasksCompleted: 0,
          task1: { completed: false, data: null },
          task2: { completed: false, data: null },
          task3: { completed: false, data: null }
        };
      });

      // Start 5-minute game timer
      startGameTimer();

      // Notify all players of their roles
      players.forEach(player => {
        const playerSocket = io.sockets.sockets.get(player.id);
        if (playerSocket) {
          playerSocket.emit('game-started', {
            role: player.role,
            tasks: player.tasks,
            players: players.map(p => ({ 
              id: p.id, 
              name: p.name, 
              color: p.color, 
              role: p.role,
              isAlive: p.isAlive 
            }))
          });
          
          // Restore task progress if exists
          if (player.role === 'crewmate' && player.taskProgress) {
            playerSocket.emit('restore-task-progress', {
              taskProgress: player.taskProgress
            });
          }
        }
      });

      if (impostorCount > 0) {
        console.log(`Game started with ${impostorCount} impostor(s):`, 
          impostorIndices.map(idx => players[idx].name));
      } else {
        console.log('Game started in solo mode (no impostor)');
      }
    }
  });

  // Crewmate reports task progress
  socket.on('task-progress', (data) => {
    const player = gameState.players.get(socket.id);
    if (player && player.role === 'crewmate') {
      socket.to('main').emit('crewmate-activity', {
        playerId: socket.id,
        playerName: player.name,
        task: data.task,
        progress: data.progress,
        screenData: data.screenData
      });
    }
  });

  // Save task progress
  socket.on('save-task-progress', (data) => {
    const player = gameState.players.get(socket.id);
    if (player && player.role === 'crewmate') {
      player.taskProgress = data.taskProgress;
      console.log(`Saved progress for ${player.name}:`, data.taskProgress);
      
      if (data.taskProgress.tasksCompleted >= 3) {
        console.log(`${player.name} completed all tasks!`);
        checkGameEnd();
      }
    }
  });

  // Task completed
  socket.on('task-completed', (data) => {
    const player = gameState.players.get(socket.id);
    if (player && player.role === 'crewmate') {
      player.taskProgress.tasksCompleted = data.tasksCompleted;
      
      io.to('main').emit('task-completed-update', {
        playerId: socket.id,
        playerName: player.name,
        tasksCompleted: data.tasksCompleted,
        totalTasks: 3
      });

      console.log(`${player.name} completed task ${data.taskId}, total: ${data.tasksCompleted}/3`);
      checkGameEnd();
    }
  });

  // Impostor attempts sabotage
  socket.on('attempt-sabotage', (data) => {
    const impostor = gameState.players.get(socket.id);
    const targetPlayer = gameState.players.get(data.targetPlayerId);

    if (impostor && impostor.role === 'impostor' && targetPlayer && targetPlayer.role === 'crewmate') {
      
      // Check kill cooldown
      const lastKillTime = gameState.killCooldowns.get(impostor.id) || 0;
      const cooldownRemaining = 30000 - (Date.now() - lastKillTime);
      
      if (cooldownRemaining > 0 && targetPlayer.sabotageCount >= 2) {
        socket.emit('kill-cooldown', { 
          remaining: Math.ceil(cooldownRemaining / 1000) 
        });
        return;
      }

      targetPlayer.sabotageCount++;

      // Broadcast sabotage attempt
      io.to('main').emit('sabotage-attempt', {
        impostorName: impostor.name,
        targetName: targetPlayer.name,
        sabotageCount: targetPlayer.sabotageCount,
        success: data.success,
        sabotageType: data.sabotageType
      });

      // Check if crewmate should die
      if (targetPlayer.sabotageCount >= 3) {
        targetPlayer.isAlive = false;
        
        // Set kill cooldown
        gameState.killCooldowns.set(impostor.id, Date.now());
        
        io.to('main').emit('player-killed', {
          playerId: targetPlayer.id,
          playerName: targetPlayer.name,
          killer: impostor.name
        });

        // Notify impostor of cooldown
        socket.emit('kill-cooldown-active', { 
          duration: 30 
        });

        checkGameEnd();
      }
    }
  });

  // Trigger sabotage
  socket.on('trigger-sabotage', (data) => {
    const impostor = gameState.players.get(socket.id);
    
    if (impostor && impostor.role === 'impostor') {
      socket.to('main').emit('sabotage-triggered', {
        sabotageType: data.sabotageType,
        impostorName: impostor.name,
        targetPlayerId: data.targetPlayerId
      });

      console.log(`Sabotage triggered by ${impostor.name}: ${data.sabotageType}`);
    }
  });

  // Report dead body
  socket.on('report-body', (data) => {
    const reporter = gameState.players.get(socket.id);
    if (reporter && reporter.isAlive) {
      io.to('main').emit('body-reported', {
        reporter: reporter.name,
        bodyLocation: data.location
      });
      
      startEmergencyMeeting();
    }
  });

  // Call emergency meeting
  socket.on('emergency-meeting', () => {
    const caller = gameState.players.get(socket.id);
    if (caller && caller.isAlive) {
      startEmergencyMeeting();
    }
  });

  // Submit vote
  socket.on('submit-vote', (data) => {
    const player = gameState.players.get(socket.id);
    if (player && player.isAlive) {
      player.vote = data.votedFor;
      
      io.to('main').emit('vote-submitted', {
        playerId: player.id,
        playerName: player.name
      });

      const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
      const votedPlayers = alivePlayers.filter(p => p.vote !== undefined && p.vote !== null);
      
      if (votedPlayers.length === alivePlayers.length) {
        processVotes();
      }
    }
  });

  // Chat message
  socket.on('chat-message', (data) => {
    const player = gameState.players.get(socket.id);
    if (player) {
      io.to('main').emit('chat-message', {
        player: player.name,
        message: data.message,
        color: player.color,
        isDead: !player.isAlive,
        role: player.role
      });
    }
  });

  // Request game state
  socket.on('request-game-state', () => {
    const player = gameState.players.get(socket.id);
    if (player) {
      const players = Array.from(gameState.players.values());
      socket.emit('game-state-update', {
        players: players.map(p => ({
          id: p.id,
          name: p.name,
          color: p.color,
          role: p.role,
          isAlive: p.isAlive,
          tasksCompleted: p.taskProgress?.tasksCompleted || 0
        })),
        timeRemaining: gameState.timeRemaining,
        gameActive: gameState.gameTimer !== null
      });

      if (player.role === 'crewmate' && player.taskProgress) {
        socket.emit('restore-task-progress', {
          taskProgress: player.taskProgress
        });
      }
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const player = gameState.players.get(socket.id);
    if (player) {
      console.log(`Player ${player.name} disconnected`);
      
      io.to('main').emit('player-disconnected', {
        playerId: socket.id,
        playerName: player.name
      });

      gameState.players.delete(socket.id);
      broadcastPlayerList();

      if (gameState.players.size === 0) {
        clearInterval(gameState.gameTimer);
        gameState.gameTimer = null;
      }
    }
  });

  // Helper functions
  function broadcastPlayerList() {
    const players = Array.from(gameState.players.values());
    io.to('main').emit('player-list-update', players);
  }

  function getRandomTasks(count) {
    const shuffled = [...CREWMATE_TASKS].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }

  function getRandomColor() {
    const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#96ceb4', '#feca57', '#ff9ff3', '#54a0ff', '#5f27cd'];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  function startEmergencyMeeting() {
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.isAlive);
    
    Array.from(gameState.players.values()).forEach(player => {
      player.vote = null;
    });

    io.to('main').emit('emergency-meeting-started', {
      players: alivePlayers.map(p => ({ 
        id: p.id, 
        name: p.name, 
        color: p.color,
        role: p.role 
      })),
      duration: gameState.meetingDuration
    });

    console.log(`Emergency meeting started with ${alivePlayers.length} alive players`);

    setTimeout(() => {
      if (gameState.players.size > 0) {
        processVotes();
      }
    }, gameState.meetingDuration * 1000);
  }

  function processVotes() {
    const votes = {};
    const voters = {};
    
    Array.from(gameState.players.values()).forEach(player => {
      if (player.vote !== undefined && player.vote !== null) {
        votes[player.vote] = (votes[player.vote] || 0) + 1;
        voters[player.id] = player.vote;
      }
    });

    let maxVotes = 0;
    let ejectedPlayerId = null;
    let tie = false;
    
    Object.entries(votes).forEach(([playerId, voteCount]) => {
      if (voteCount > maxVotes) {
        maxVotes = voteCount;
        ejectedPlayerId = playerId;
        tie = false;
      } else if (voteCount === maxVotes && maxVotes > 0) {
        tie = true;
      }
    });

    if (ejectedPlayerId && maxVotes > 0 && !tie) {
      const ejectedPlayer = gameState.players.get(ejectedPlayerId);
      if (ejectedPlayer) {
        ejectedPlayer.isAlive = false;
        
        io.to('main').emit('player-ejected', {
          playerId: ejectedPlayer.id,
          playerName: ejectedPlayer.name,
          role: ejectedPlayer.role,
          votes: votes,
          voters: voters
        });

        console.log(`Player ejected: ${ejectedPlayer.name} (${ejectedPlayer.role})`);
        checkGameEnd();
      }
    } else {
      io.to('main').emit('no-one-ejected', {
        tie: tie,
        votes: votes
      });
      console.log('No one was ejected' + (tie ? ' (tie)' : ''));
    }

    Array.from(gameState.players.values()).forEach(player => {
      player.vote = null;
    });
  }

  function checkGameEnd() {
    const players = Array.from(gameState.players.values());
    const aliveCrewmates = players.filter(p => p.isAlive && p.role === 'crewmate');
    const aliveImpostors = players.filter(p => p.isAlive && p.role === 'impostor');

    let winner = null;
    let reason = '';

    if (aliveImpostors.length === 0) {
      winner = 'crewmates';
      reason = 'All impostors eliminated';
    } else if (aliveImpostors.length >= aliveCrewmates.length) {
      winner = 'impostor';
      reason = 'Impostors outnumber crewmates';
    } else {
      const crewmates = players.filter(p => p.role === 'crewmate');
      const allTasksCompleted = crewmates.every(crewmate => 
        crewmate.taskProgress.tasksCompleted >= 3
      );
      
      if (allTasksCompleted) {
        winner = 'crewmates';
        reason = 'All tasks completed';
      }
    }

    if (gameState.timeRemaining <= 0 && !winner) {
      winner = 'impostor';
      reason = 'Time ran out';
    }

    if (winner) {
      endGame(winner, reason);
    }
  }

  function startGameTimer() {
    gameState.timeRemaining = 300;
    clearInterval(gameState.gameTimer);
    
    gameState.gameTimer = setInterval(() => {
      gameState.timeRemaining--;
      
      io.to('main').emit('game-timer-update', {
        timeRemaining: gameState.timeRemaining,
        minutes: Math.floor(gameState.timeRemaining / 60),
        seconds: gameState.timeRemaining % 60
      });

      if (gameState.timeRemaining <= 0) {
        clearInterval(gameState.gameTimer);
        checkGameEnd();
      }
    }, 1000);
  }

  function endGame(winners, reason) {
    clearInterval(gameState.gameTimer);
    gameState.gameTimer = null;
    
    const players = Array.from(gameState.players.values());
    
    io.to('main').emit('game-ended', { 
      winners: winners, 
      reason: reason,
      players: players.map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        tasksCompleted: p.taskProgress?.tasksCompleted || 0,
        isAlive: p.isAlive
      }))
    });

    console.log(`Game ended: ${winners} win - ${reason}`);

    setTimeout(() => {
      players.forEach(player => {
        player.role = null;
        player.isAlive = true;
        player.sabotageCount = 0;
        player.vote = null;
        player.taskProgress = {
          tasksCompleted: 0,
          task1: { completed: false, data: null },
          task2: { completed: false, data: null },
          task3: { completed: false, data: null }
        };
      });
      
      io.to('main').emit('return-to-lobby');
    }, 15000);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎮 Among Us Cyber Server running on port ${PORT}`);
  console.log(`🌍 Players worldwide can join!`);
});