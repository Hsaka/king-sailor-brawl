#!/bin/bash
set -e

echo "📦 Installing dependencies..."
sudo apt update -qq
sudo apt install -y xfce4 xfce4-goodies x11vnc xvfb novnc websockify dbus-x11 xfonts-base

echo "🌐 Installing browser..."
if sudo apt install -y chromium 2>/dev/null; then
    BROWSER="chromium --no-sandbox"
elif sudo apt install -y chromium-browser 2>/dev/null; then
    BROWSER="chromium-browser --no-sandbox"
elif sudo snap install firefox 2>/dev/null; then
    BROWSER="firefox"
elif sudo apt install -y firefox 2>/dev/null; then
    BROWSER="firefox"
else
    sudo add-apt-repository ppa:mozillateam/ppa -y
    sudo apt update -qq
    sudo apt install -y firefox-esr
    BROWSER="firefox"
fi

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

echo "🚀 Launching browser..."
DISPLAY=:1 $BROWSER &

echo ""
echo "✅ Done! Next steps:"
echo "   1. Click the 'Ports' tab in the bottom panel"
echo "   2. Add port 6080 if not listed"
echo "   3. Right-click port 6080 → set to Public"
echo "   4. Open the Forwarded Address URL + /vnc.html"
echo ""
echo "   Example: https://your-codespace-url-6080.preview.app.github.dev/vnc.html"