#!/bin/bash
# dev-temp.sh - run Vite dev with temporary index.html

set -e

# 1️⃣ Create minimal index.html
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

# 2️⃣ Setup trap to remove index.html on exit
cleanup() {
  rm -f index.html
  echo "🗑 Temporary index.html removed"
}
trap cleanup EXIT

# 3️⃣ Run Vite dev server
vite
