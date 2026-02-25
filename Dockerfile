FROM node:18-alpine
WORKDIR /app

# Copy everything to temp location first
COPY . /tmp/build/

# Smart copy: handles both flat and nested repo structures
RUN if [ -f /tmp/build/server.js ]; then \
      echo "FLAT structure detected"; \
      cp -r /tmp/build/* /app/ 2>/dev/null; \
      cp /tmp/build/.env /app/.env 2>/dev/null || true; \
    else \
      echo "NESTED structure detected, searching..."; \
      FOUND=$(find /tmp/build -name "server.js" -maxdepth 3 | head -1); \
      if [ -n "$FOUND" ]; then \
        DIR=$(dirname "$FOUND"); \
        echo "Found app in: $DIR"; \
        cp -r "$DIR"/* /app/ 2>/dev/null; \
        cp "$DIR"/.env /app/.env 2>/dev/null || true; \
      else \
        echo "server.js not found anywhere!"; \
        find /tmp/build -type f | head -20; \
        exit 1; \
      fi; \
    fi

# Clean up temp
RUN rm -rf /tmp/build

# Install dependencies
RUN npm install --production

# Debug: confirm structure is correct
RUN echo "=== /app contents ===" && ls -la /app/ && \
    echo "=== /app/public contents ===" && ls -la /app/public/ && \
    echo "Build OK"

EXPOSE 3005
CMD ["node", "server.js"]
