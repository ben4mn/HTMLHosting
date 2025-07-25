#!/bin/bash

# Navigate to project directory
cd /Users/ben/Documents/HostingStrategy/html-hosting

echo "Setting up Git repository for HTML Hosting project..."

# Initialize git repository
git init

# Add remote repository
git remote add origin https://github.com/ben4mn/HTMLHosting.git

# Add all files (respecting .gitignore)
git add .

# Create initial commit
git commit -m "Initial commit: HTML hosting service with Docker support

Features:
- HTML file upload and hosting service
- Automatic file expiration (30 days)
- Rate limiting and security headers
- SQLite database for metadata storage
- Docker deployment support
- Responsive web interface with drag-and-drop
- File cleanup utilities and analytics
- Comprehensive documentation

Tech Stack:
- Node.js/Express backend
- SQLite database
- Docker containerization
- Modern HTML/CSS/JavaScript frontend
- Security middleware (Helmet, CORS, Rate Limiting)"

# Push to GitHub
git push -u origin main

echo "Successfully pushed to GitHub!"
echo "Repository URL: https://github.com/ben4mn/HTMLHosting.git"
