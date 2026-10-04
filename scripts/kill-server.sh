#!/bin/bash
# Kill any processes using port 3001

PORT=3001
PIDS=$(lsof -ti:$PORT 2>/dev/null)

if [ -z "$PIDS" ]; then
    echo "No processes found on port $PORT"
else
    echo "Killing processes on port $PORT: $PIDS"
    kill -9 $PIDS 2>/dev/null
    sleep 1
    echo "Port $PORT is now free"
fi
