const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { initDatabase } = require('./database');
const uploadRoutes = require('./routes/upload');
const viewRoutes = require('./routes/view');
const apiV2Routes = require('./routes/api-v2');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (for correct IP detection behind nginx/cloudflare)
app.set('trust proxy', 1);

// Initialize database
initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Security middleware - disable CSP globally since view routes set their own
app.use(helmet({
  contentSecurityPolicy: false, // Let individual routes handle CSP
  crossOriginEmbedderPolicy: false
}));

// Rate limiting for uploads
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 uploads per window
  message: {
    error: 'Too many uploads, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for password attempts
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per slug per window
  message: {
    error: 'Too many password attempts, please try again later.',
    retryAfter: '15 minutes'
  },
  keyGenerator: (req) => {
    const slug = req.params.slug || 'unknown';
    const ip = req.ip || req.connection.remoteAddress;
    return `${ip}:${slug}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

// CORS configuration
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? 'https://hosting.zyroi.com' : true,
  credentials: true
}));

// Cookie parser for password auth
app.use(cookieParser(process.env.COOKIE_SECRET || 'html-hosting-secret-key'));

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api', uploadLimiter, uploadRoutes);

// API v2 Routes (authenticated, for AI agents)
app.use('/api/v2', apiV2Routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Root route with secure CSP for upload page
app.get('/', (req, res) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com;"
  });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// List page route
app.get('/list', (req, res) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' https://cdnjs.cloudflare.com;"
  });
  res.sendFile(path.join(__dirname, 'public', 'list.html'));
});

// View routes - must be last before 404 handler (catches /:slug)
app.use('/', viewRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`HTML Hosting Service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});