#!/bin/sh
set -e

echo "Starting application..."

# Run database migrations if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
  echo "Running database migrations..."
  npx prisma migrate deploy --schema=/app/prisma/schema.prisma 2>&1 || {
    echo "Migration failed or no migrations to run. Trying db push as fallback..."
    npx prisma db push --schema=/app/prisma/schema.prisma --accept-data-loss=false 2>&1 || {
      echo "Warning: Database sync failed. The application may have missing tables."
    }
  }
  echo "Database sync complete."
else
  echo "Warning: DATABASE_URL not set, skipping migrations."
fi

# Start the application
echo "Starting Node.js application..."
exec node dist/index.js
