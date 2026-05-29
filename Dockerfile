# Use a lightweight Node.js base image
FROM node:20-alpine

# Install git, since some txamcp tools execute git CLI commands
RUN apk add --no-cache git

# Set environment to production
ENV NODE_ENV=production
ENV ENABLE_HTTP_GATEWAY=true
ENV MCP_PORT=3636

# Create and set the working directory
WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy source code and documentation
COPY mcp-server.mjs cli.js instructions.md ./

# Expose the default HTTP/SSE Gateway port
EXPOSE 3636

# Run the MCP server
CMD ["node", "mcp-server.mjs"]
