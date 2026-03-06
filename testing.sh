#!/bin/bash
set -e

echo "📦 Installing dependencies..."
sudo rm -f /etc/apt/sources.list.d/yarn.list
sudo apt update -qq 2>&1 | grep -v "^W:" || true
sudo apt install -y xfce4 xfce4-goodies x11vnc xvfb novnc websockify dbus-x11 xfonts-base

echo "🌐 Installing browser..."
sudo apt install -y firefox-esr 2>/dev/null || true
BROWSER="firefox-esr"

echo "🖥️  Starting virtual display..."
pkill Xvfb 2>/dev/null || true
Xvfb :1 -screen 0 1280x720x24 &
sleep 2

echo "🖼️  Starting XFCE desktop..."
DISPLAY=:1 startxfce4 &
sleep 4

echo "🔗 Starting x11vnc..."
x11vnc -display :1 -nopw -listen localhost -xkb -forever -shared &
sleep 2

echo "🌍 Starting noVNC on port 6080..."
websockify --web /usr/share/novnc/ 6080 localhost:5900 &
sleep 2

echo "🚀 Serving web app..."
cd /workspaces/$(ls /workspaces | head -1)
python3 -m http.server 8080 &
sleep 2

echo "🚀 Launching browser..."
DISPLAY=:1 $BROWSER http://localhost:8080 &

echo ""
echo "✅ Done! Next steps:"
echo "   1. Click the 'Ports' tab in the bottom panel"
echo "   2. Add port 6080 if not listed"
echo "   3. Right-click port 6080 → set to Public"
echo "   4. Open the Forwarded Address URL + /vnc.html"
echo ""
echo "   Example: https://your-codespace-url-6080.preview.app.github.dev/vnc.html"