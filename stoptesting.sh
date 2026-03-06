#!/bin/bash

echo "🛑 Stopping all desktop services..."

pkill -f "NoCacheHandler" 2>/dev/null && echo "✅ Python server stopped" || echo "⚠️  Python server not running"
pkill -f "websockify" 2>/dev/null && echo "✅ noVNC stopped" || echo "⚠️  noVNC not running"
pkill -f "x11vnc" 2>/dev/null && echo "✅ x11vnc stopped" || echo "⚠️  x11vnc not running"
pkill -f "startxfce4" 2>/dev/null && echo "✅ XFCE stopped" || echo "⚠️  XFCE not running"
pkill Xvfb 2>/dev/null && echo "✅ Xvfb stopped" || echo "⚠️  Xvfb not running"

echo "Done."