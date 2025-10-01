#!/bin/bash
# build-temp.sh - build Vite app without keeping index.html in root

set -e

# 1️⃣ Create a minimal index.html temporarily
cat > index.html <<EOL
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <link rel="icon" type="image/svg+xml" href="/vite.svg" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>modular-account-v2-utility</title>
</head>

<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>

</html>
EOL

echo "📝 Temporary index.html created"

# 2️⃣ Build the app
npx vite build

echo "✅ Build complete"

# 3️⃣ Remove the temporary index.html
rm index.html

echo "🗑 Temporary index.html removed"
