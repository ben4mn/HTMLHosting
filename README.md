# HTML Hosting Service

A temporary HTML file hosting service for `hosting.zyroi.com`.

## Features

- ✅ Upload HTML files up to 10MB
- ✅ Automatic file expiration (30 days)
- ✅ UUID-based file URLs
- ✅ Rate limiting (10 uploads per 15 minutes per IP)
- ✅ Drag & drop interface
- ✅ View counter and analytics
- ✅ Automatic cleanup of expired files
- ✅ Responsive design
- ✅ Security headers and validation

## Quick Start

### Local Development

1. **Install dependencies:**
   ```bash
   cd app
   npm install
   ```

2. **Start the server:**
   ```bash
   npm start
   ```

3. **Open in browser:**
   Navigate to `http://localhost:3000`

### Docker Deployment

1. **Build the image:**
   ```bash
   docker build -t html-hosting-app .
   ```

2. **Run the container:**
   ```bash
   docker run -d -p 3011:3000 \
     --name html-hosting-container \
     --restart unless-stopped \
     -v $(pwd)/uploads:/app/uploads \
     -v $(pwd)/database:/app/database \
     html-hosting-app
   ```

## API Endpoints

- `POST /api/upload` - Upload HTML file
- `GET /view/{uuid}` - View uploaded file
- `GET /view/{uuid}/info` - Get file metadata
- `GET /health` - Health check

## Maintenance

### Cleanup expired files:
```bash
node cleanup.js
```

### Get storage statistics:
```bash
node cleanup.js stats
```

### Set up automated cleanup (cron):
```bash
# Daily cleanup at 2 AM
0 2 * * * cd /path/to/html-hosting/app && node cleanup.js
```

## Configuration

Copy `.env.example` to `.env` and modify as needed:

```bash
cp .env.example .env
```

## File Structure

```
html-hosting/
├── app/
│   ├── server.js           # Main server file
│   ├── database.js         # Database operations
│   ├── cleanup.js          # Cleanup utility
│   ├── package.json        # Dependencies
│   ├── routes/
│   │   ├── upload.js       # Upload endpoints
│   │   └── view.js         # View endpoints
│   ├── public/
│   │   └── index.html      # Upload interface
│   └── views/
│       └── error.html      # Error page template
├── uploads/                # File storage
├── database/              # SQLite database
└── Dockerfile             # Container configuration
```

## Security Features

- File type validation (HTML only)
- File size limits (10MB max)
- Rate limiting per IP address
- XSS protection headers
- CORS configuration
- Content Security Policy
- Automatic file expiration

## Database Schema

```sql
CREATE TABLE hosted_files (
  id TEXT PRIMARY KEY,              -- UUID
  filename TEXT NOT NULL,           -- Always 'index.html'
  original_name TEXT NOT NULL,      -- User's original filename
  upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  expiry_time DATETIME NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  access_count INTEGER DEFAULT 0,
  upload_ip TEXT,                   -- For rate limiting
  user_agent TEXT                   -- For analytics
);
```