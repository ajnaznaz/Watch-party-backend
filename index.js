const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

const server = http.createServer(app);

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// PeerJS server
const peerServer = ExpressPeerServer(server, {
  path: '/peerjs',
  debug: true,
  allow_discovery: true,
  proxied: true,
  cors_options: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use('/peerjs', peerServer);

// Store room data
const rooms = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get room info
app.get('/api/room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);

  if (room) {
    res.json({
      exists: true,
      userCount: room.users.size,
      users: Array.from(room.users.values())
    });
  } else {
    res.json({ exists: false, userCount: 0, users: [] });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  let currentRoom = null;
  let currentUser = null;

  // Join room
  socket.on('join-room', (data) => {
    const { roomId, peerId, userName } = data;

    // Get or create room
    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        users: new Map(),
        movieState: {
          isPlaying: false,
          currentTime: 0,
          playbackSpeed: 1,
          lastUpdate: Date.now()
        },
        messages: [],
        reactions: []
      });
    }

    const room = rooms.get(roomId);

    // Check if room is full (max 2 users for watch party)
    if (room.users.size >= 2) {
      socket.emit('room-full');
      return;
    }

    currentRoom = roomId;
    currentUser = {
      id: socket.id,
      peerId,
      userName: userName || 'Guest',
      joinedAt: Date.now()
    };

    // Add user to room
    room.users.set(socket.id, currentUser);
    socket.join(roomId);

    // Notify others in room
    socket.to(roomId).emit('user-joined', currentUser);

    // Send current room state to new user
    socket.emit('room-state', {
      users: Array.from(room.users.values()),
      movieState: room.movieState,
      messages: room.messages.slice(-50) // Last 50 messages
    });

    console.log(`User ${currentUser.userName} joined room ${roomId}`);
  });

  // Movie sync events
  socket.on('movie-play', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (room) {
      room.movieState.isPlaying = true;
      room.movieState.currentTime = data.currentTime;
      room.movieState.playbackSpeed = data.playbackSpeed || 1;
      room.movieState.lastUpdate = Date.now();

      socket.to(currentRoom).emit('movie-play', data);
    }
  });

  socket.on('movie-pause', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (room) {
      room.movieState.isPlaying = false;
      room.movieState.currentTime = data.currentTime;
      room.movieState.lastUpdate = Date.now();

      socket.to(currentRoom).emit('movie-pause', data);
    }
  });

  socket.on('movie-seek', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (room) {
      room.movieState.currentTime = data.currentTime;
      room.movieState.lastUpdate = Date.now();

      socket.to(currentRoom).emit('movie-seek', data);
    }
  });

  socket.on('movie-speed-change', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (room) {
      room.movieState.playbackSpeed = data.playbackSpeed;
      room.movieState.lastUpdate = Date.now();

      socket.to(currentRoom).emit('movie-speed-change', data);
    }
  });

  // Chat events
  socket.on('send-message', (data) => {
    if (!currentRoom) return;

    const room = rooms.get(currentRoom);
    if (room) {
      const message = {
        id: Date.now().toString(),
        userId: socket.id,
        userName: currentUser?.userName || 'Guest',
        text: data.text,
        timestamp: Date.now(),
        emoji: data.emoji || null
      };

      room.messages.push(message);

      // Keep only last 100 messages
      if (room.messages.length > 100) {
        room.messages = room.messages.slice(-100);
      }

      io.to(currentRoom).emit('new-message', message);
    }
  });

  // Typing indicator
  socket.on('typing-start', () => {
    if (currentRoom && currentUser) {
      socket.to(currentRoom).emit('user-typing', { userName: currentUser.userName });
    }
  });

  socket.on('typing-stop', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-stopped-typing');
    }
  });

  // Reactions
  socket.on('send-reaction', (data) => {
    if (!currentRoom) return;

    const reaction = {
      id: Date.now().toString(),
      userId: socket.id,
      userName: currentUser?.userName || 'Guest',
      emoji: data.emoji,
      timestamp: Date.now()
    };

    io.to(currentRoom).emit('new-reaction', reaction);
  });

  // WebRTC signaling through socket (fallback)
  socket.on('webrtc-offer', (data) => {
    socket.to(data.targetPeerId).emit('webrtc-offer', {
      offer: data.offer,
      senderPeerId: currentUser?.peerId
    });
  });

  socket.on('webrtc-answer', (data) => {
    socket.to(data.targetPeerId).emit('webrtc-answer', {
      answer: data.answer,
      senderPeerId: currentUser?.peerId
    });
  });

  socket.on('webrtc-ice-candidate', (data) => {
    socket.to(data.targetPeerId).emit('webrtc-ice-candidate', {
      candidate: data.candidate,
      senderPeerId: currentUser?.peerId
    });
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);

      // Remove user from room
      room.users.delete(socket.id);

      // Notify others
      socket.to(currentRoom).emit('user-left', {
        id: socket.id,
        userName: currentUser?.userName
      });

      // Clean up empty rooms
      if (room.users.size === 0) {
        rooms.delete(currentRoom);
        console.log(`Room ${currentRoom} deleted (empty)`);
      }
    }
  });

  // Leave room explicitly
  socket.on('leave-room', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(socket.id);

      socket.to(currentRoom).emit('user-left', {
        id: socket.id,
        userName: currentUser?.userName
      });

      socket.leave(currentRoom);

      if (room.users.size === 0) {
        rooms.delete(currentRoom);
      }

      currentRoom = null;
      currentUser = null;
    }
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.io server ready`);
  console.log(`PeerJS server available at /peerjs`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, server, io };
