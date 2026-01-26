# HTML Hosting Service

A lightweight hosting service purpose-built for developers who frequently work with AI code generation. Upload HTML files and instantly get shareable URLs - perfect for quickly previewing AI-generated web pages, sharing prototypes with stakeholders, or testing responsive designs. The service handles automatic cleanup of old files and provides a simple API for programmatic uploads.

## Features

- Instant shareable URLs for uploaded HTML files
- Automatic file expiration and cleanup
- Simple REST API for programmatic uploads
- SQLite-backed file tracking
- Docker-ready for self-hosting

## Tech Stack

Node.js, Express, SQLite, Docker

## Getting Started

### Prerequisites

- Node.js 18+

### Installation

```bash
git clone https://github.com/ben4mn/HTMLHosting.git
cd HTMLHosting/app
npm install
```

### Running

```bash
# Start the server
npm start

# Development with auto-reload
npm run dev
```

Access the application at http://localhost:3000

#### Docker Deployment

```bash
# Build the image
docker build -t html-hosting-app .

# Run the container
docker run -d -p 3011:3000 \
  --name html-hosting-container \
  --restart unless-stopped \
  -v $(pwd)/uploads:/app/uploads \
  -v $(pwd)/database:/app/database \
  html-hosting-app
```

## License

MIT
