# CLAUDE.md - AI Assistant Guide for HTMLHosting

This document provides essential context for AI assistants working on this codebase.

## Project Overview

HTMLHosting is a temporary HTML file hosting service for `hosting.zyroi.com`. Users can upload HTML files with custom or auto-generated URL slugs, optional descriptions, and configurable expiration periods (including permanent links).

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
│   │   ├── upload.js         # Upload, list, archive, delete APIs (web UI)
│   │   ├── api-v2.js         # Authenticated JSON API for AI agents
│   │   └── view.js           # GET /:slug - serve HTML content
│   ├── middleware/
│   │   └── auth.js           # API key authentication middleware
│   ├── utils/
│   │   └── validation.js     # Shared validation functions
│   ├── public/
│   │   ├── index.html        # Upload interface (single-page app)
│   │   └── list.html         # Full file list with search
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

### Web UI API (v1)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload HTML file (rate limited: 10/15min) |
| GET | `/api/recent` | List 5 most recent uploads |
| GET | `/api/files` | List all files (supports `?search=` query) |
| GET | `/api/check-slug/:slug` | Check if a custom slug is available |
| POST | `/api/archive/:slug` | Archive a file (hide from public view) |
| POST | `/api/unarchive/:slug` | Unarchive a file |
| DELETE | `/api/file/:slug` | Permanently delete a file |
| GET | `/:slug` | Serve uploaded HTML content |
| GET | `/:slug/info` | Get file metadata (JSON) |
| GET | `/list` | Full file list page with search |
| GET | `/health` | Health check endpoint |

### Programmatic API (v2) - For AI Agents

Authenticated JSON API for programmatic access. **Full documentation available at `GET /api/v2`**.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/v2` | No | API discovery - returns full documentation |
| POST | `/api/v2/upload` | Yes | Create HTML page or ZIP project |
| PUT | `/api/v2/upload/:slug` | Yes | Update existing page (owner only) |
| GET | `/api/v2/file/:slug` | Yes | Get file metadata |
| DELETE | `/api/v2/file/:slug` | Yes | Delete file (owner only) |
| GET | `/api/v2/check-slug/:slug` | Yes | Check slug availability |

**Authentication**: Include `X-API-Key: <key>` header or `Authorization: Bearer <key>`

**Example - Upload HTML**:
```bash
curl -X POST https://hosting.zyroi.com/api/v2/upload \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"html": "<html><body>Hello</body></html>", "slug": "my-page"}'
```

**Example - Upload ZIP** (base64 encoded):
```bash
curl -X POST https://hosting.zyroi.com/api/v2/upload \
  -H "X-API-Key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"zip": "BASE64_ENCODED_ZIP", "slug": "my-project"}'
```

**Response**:
```json
{
  "success": true,
  "id": "uuid",
  "slug": "my-page",
  "url": "https://hosting.zyroi.com/my-page/",
  "size": 1024,
  "expiresAt": "2024-03-15T12:00:00.000Z",
  "permanent": false,
  "passwordProtected": false,
  "uploadType": "html",
  "fileCount": 1
}
```

## Database Schema

Single table `hosted_files` in SQLite:

```sql
CREATE TABLE hosted_files (
  id TEXT PRIMARY KEY,           -- UUID v4 (internal reference)
  slug TEXT UNIQUE NOT NULL,     -- URL slug (custom or auto-generated)
  filename TEXT NOT NULL,        -- Always 'index.html'
  original_name TEXT NOT NULL,   -- Sanitized original filename
  description TEXT DEFAULT '',   -- Optional user description
  upload_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  expiry_time DATETIME,          -- NULL for permanent links
  file_path TEXT NOT NULL,       -- Absolute path to file
  file_size INTEGER NOT NULL,
  access_count INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,    -- 1 if archived, 0 if active
  upload_ip TEXT,                -- Client IP for rate limiting
  user_agent TEXT,               -- For analytics
  upload_type TEXT DEFAULT 'html', -- 'html' or 'zip'
  file_count INTEGER DEFAULT 1,  -- Number of files (for ZIP uploads)
  password_hash TEXT,            -- bcrypt hash if password protected
  password_hint TEXT,            -- Optional password hint
  api_key_hash TEXT              -- SHA-256 hash of API key (for ownership)
);
```

**Indexes**: `idx_slug`, `idx_expiry_time`, `idx_upload_ip`, `idx_archived`

## Key Features

### Custom URLs
- Users can request custom URL slugs (e.g., `my-project`)
- Auto-generates 8-character random slugs if not specified
- Validates: alphanumeric, hyphens, underscores only
- Reserved slugs blocked: `api`, `health`, `list`, `admin`, etc.

### Flexible Expiration
- Options: 1 day, 30 days, 6 months, or permanent (no expiry)
- Permanent links have `expiry_time = NULL`
- Cleanup process skips permanent files

### Archive Functionality
- Archived files remain in database and file list
- Archived files return 410 "Content Archived" when accessed
- Can be unarchived to restore access

### File List & Search
- Landing page shows 5 most recent uploads
- `/list` page shows all files with search
- Search matches filename, description, or slug

## Key Architectural Patterns

### File Storage
- Files stored in `uploads/{uuid}/index.html`
- Each upload gets its own directory
- Cleanup removes entire upload directory on expiration

### URL Routing
- Slug-based URLs at root level: `/{slug}`
- Static files and API routes take precedence
- View routes mounted last to catch slugs

### Security Measures
- **File validation**: HTML-only (`.html`, `.htm` extensions, `text/html` MIME)
- **Size limit**: 10MB maximum
- **Rate limiting**: 10 uploads per 15 minutes per IP
- **Content Security Policy**: Strict on upload page, permissive on served content
- **Security headers**: X-Frame-Options, X-Content-Type-Options, X-XSS-Protection

### Error Handling
- Custom error pages with styled HTML (generated inline in `view.js`)
- 404 for missing files
- 410 for expired or archived content
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
- Log format: `File uploaded: {slug} ({filename}, {size} bytes)`
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
| API_KEYS | (none) | Comma-separated API keys for v2 API |
| API_RATE_LIMIT | 100 | API v2 requests per window |
| API_RATE_WINDOW | 900000 | API v2 rate limit window (ms) |

## Important Implementation Details

### Upload Flow
1. Multer processes file into memory buffer
2. Content validated as HTML (`validateHtmlContent()`)
3. Custom slug validated or random slug generated
4. UUID generated, directory created
5. File written to disk as `index.html`
6. Database record inserted with slug, description, expiry
7. Shareable URL returned

### View Flow
1. Slug validated (alphanumeric, hyphens, underscores)
2. Database queried for non-expired, non-archived record
3. File existence verified on disk
4. Access count incremented (non-blocking)
5. HTML served with permissive CSP

### Archive/Delete Flow
- Archive: Sets `archived = 1` in database, file remains on disk
- Unarchive: Sets `archived = 0`, restores access
- Delete: Removes database record AND file from disk

### Cleanup Process
1. Query expired files from database (excludes NULL expiry)
2. Delete directories from filesystem
3. Remove records from database
4. Can run via cron: `0 2 * * * cd /path/to/app && node cleanup.js`

## Testing Considerations

- No test framework currently configured
- Test files available: `test-sample.html`, `test-simple.html`
- Manual testing via upload interface or curl:

```bash
# Basic upload
curl -F "htmlfile=@test-sample.html" http://localhost:3000/api/upload

# Upload with options
curl -F "htmlfile=@test-sample.html" \
     -F "customSlug=my-test" \
     -F "description=Test upload" \
     -F "duration=permanent" \
     http://localhost:3000/api/upload
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
4. Delete existing database to recreate with new schema

### Adding New Duration Options
1. Update `calculateExpiryTime()` in `upload.js`
2. Add option to duration dropdown in `index.html`

## Gotchas and Edge Cases

1. **CSP disabled globally** in Helmet - individual routes set their own
2. **CORS origin** differs between production (strict) and development (permissive)
3. **Slug validation** uses regex - alphanumeric, hyphens, underscores only
4. **Database singleton** - `db` variable is module-scoped, shared across requires
5. **Graceful shutdown** handlers exist for SIGTERM and SIGINT
6. **Health check** at `/health` used by Docker HEALTHCHECK
7. **View routes last** - must be mounted after all other routes to catch slugs
8. **NULL expiry** - permanent files have `expiry_time = NULL` in database
