# HTML Hosting Service Dockerfile
FROM node:18-slim

# Set working directory
WORKDIR /app

# Create app user for security
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs nodejs

# Copy package files
COPY app/package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY app/ .

# Create necessary directories with proper permissions
RUN mkdir -p uploads database && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["node", "server.js"]