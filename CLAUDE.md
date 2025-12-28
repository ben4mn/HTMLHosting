# CLAUDE.md - AI Assistant Guide for HTMLHosting

This document provides essential context for AI assistants working on this codebase.

## Project Overview

HTMLHosting is a temporary HTML file hosting service for `hosting.zyroi.com`. Users can upload HTML files which are assigned UUID-based URLs and automatically expire after 30 days.

### Tech Stack

- **Runtime**: Node.js >= 18.0.0
- **Framework**: Express.js 4.x
- **Database**: SQLite3 (file-based)
- **File Handling**: Multer (memory storage)
- **Security**: Helmet, express-rate-limit, CORS
- **Containerization**: Docker (Alpine-based)

## Project Structure

```
HTMLHosting/
├── app/                      # Application source code
│   ├── server.js             # Main Express server entry point
│   ├── database.js           # SQLite database operations module
│   ├── cleanup.js            # CLI utility for expired file cleanup
│   ├── package.json          # Dependencies and scripts
│   ├── .env.example          # Environment configuration template
│   ├── routes/
│   │   ├── upload.js         # POST /api/upload, GET /api/recent
│   │   └── view.js           # GET /view/:id, GET /view/:id/info
│   ├── public/
│   │   └── index.html        # Upload interface (single-page app)
│   └── views/
│       └── error.html        # Error page template (unused, inline in view.js)
├── uploads/                  # UUID-organized file storage directories
├── database/                 # SQLite database files (hosting.db)
├── Dockerfile                # Production container configuration
├── .gitignore
└── README.md
```

## Development Commands

```bash
# Install dependencies
cd app && npm install

# Development server with hot reload
npm run dev

# Production server
npm start

# Cleanup expired files
npm run cleanup
# or
node cleanup.js

# View storage statistics
node cleanup.js stats
```

## Docker Deployment

```bash
# Build
docker build -t html-hosting-app .

# Run (maps port 3011 to container 3000)
docker run -d -p 3011:3000 \
  --name html-hosting-container \
  --restart unless-stopped \
  -v $(pwd)/uploads:/app/uploads \
  -v $(pwd)/database:/app/database \
  html-hosting-app
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload HTML file (rate limited: 10/15min) |
| GET | `/api/recent` | List recent uploads (last 24h, max 20) |
| GET | `/view/:uuid` | Serve uploaded HTML content |
| GET | `/view/:uuid/info` | Get file metadata (JSON) |
| GET | `/health` | Health check endpoint |

## Database Schema

Single table `hosted_files` in SQLite:

```sql
CREATE TABLE hosted_files (
  id TEXT PRIMARY KEY,           -- UUID v4
  filename TEXT NOT NULL,        -- Always 'index.html'
  original_name TEXT NOT NULL,   -- Sanitized original filename
  upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  expiry_time DATETIME NOT NULL, -- 30 days from upload
  file_path TEXT NOT NULL,       -- Absolute path to file
  file_size INTEGER NOT NULL,
  access_count INTEGER DEFAULT 0,
  upload_ip TEXT,                -- Client IP for rate limiting
  user_agent TEXT                -- For analytics
);
```

**Indexes**: `idx_expiry_time`, `idx_upload_ip`

## Key Architectural Patterns

### File Storage
- Files stored in `uploads/{uuid}/index.html`
- Each upload gets its own directory
- Cleanup removes entire upload directory on expiration

### Security Measures
- **File validation**: HTML-only (`.html`, `.htm` extensions, `text/html` MIME)
- **Size limit**: 10MB maximum
- **Rate limiting**: 10 uploads per 15 minutes per IP
- **Content Security Policy**: Strict on upload page, permissive on served content
- **Security headers**: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection

### Error Handling
- Custom error pages with styled HTML (generated inline in `view.js`)
- 404 for missing files
- 410 for expired content
- JSON error responses for API endpoints

## Code Conventions

### Module Pattern
- CommonJS (`require`/`module.exports`)
- Promise-based async operations with async/await
- Database functions return Promises wrapping callbacks

### File Naming
- All lowercase with dots (e.g., `database.js`)
- Route files match URL path (`upload.js` → `/api/upload`)

### Error Responses
```javascript
// API error format
{ success: false, error: 'Error message' }

// API success format
{ success: true, ...data }
```

### Logging
- Console logging with prefixes
- Log format: `File uploaded: {uuid} ({filename}, {size} bytes)`
- Errors: `console.error('Context:', error)`

## Environment Variables

See `.env.example` for all options:

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3000 | Server port |
| NODE_ENV | development | Environment mode |
| MAX_FILE_SIZE | 10485760 | Max upload size in bytes |
| DEFAULT_EXPIRY_DAYS | 30 | File expiration in days |
| UPLOAD_RATE_LIMIT | 10 | Uploads per window |
| UPLOAD_RATE_WINDOW | 900000 | Rate limit window (ms) |
| ALLOWED_ORIGINS | * | CORS allowed origins |

## Important Implementation Details

### Upload Flow
1. Multer processes file into memory buffer
2. Content validated as HTML (`validateHtmlContent()`)
3. UUID generated, directory created
4. File written to disk as `index.html`
5. Database record inserted
6. Shareable URL returned

### View Flow
1. UUID validated (regex check)
2. Database queried for non-expired record
3. File existence verified on disk
4. Access count incremented (non-blocking)
5. HTML served with permissive CSP

### Cleanup Process
1. Query expired files from database
2. Delete directories from filesystem
3. Remove records from database
4. Can run via cron: `0 2 * * * cd /path/to/app && node cleanup.js`

## Testing Considerations

- No test framework currently configured
- Test files available: `test-sample.html`, `test-simple.html`
- Manual testing via upload interface or curl:

```bash
curl -F "htmlfile=@test-sample.html" http://localhost:3000/api/upload
```

## Common Tasks

### Adding a New API Endpoint
1. Create route handler in appropriate file under `app/routes/`
2. Register in `server.js` with `app.use()`
3. Apply rate limiting if needed

### Modifying Database Schema
1. Update table creation in `database.js` `initDatabase()`
2. Add new query functions as needed
3. Export from module.exports

### Changing Expiration Period
- Modify `expiryTime.setDate(expiryTime.getDate() + 30)` in `upload.js:87`
- Or make configurable via `DEFAULT_EXPIRY_DAYS` env var

## Gotchas and Edge Cases

1. **CSP disabled globally** in Helmet - individual routes set their own
2. **CORS origin** differs between production (strict) and development (permissive)
3. **File path validation** relies on UUID format check, not path traversal check
4. **Database singleton** - `db` variable is module-scoped, shared across requires
5. **Graceful shutdown** handlers exist for SIGTERM and SIGINT
6. **Health check** at `/health` used by Docker HEALTHCHECK
