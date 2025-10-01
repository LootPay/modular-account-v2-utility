# 🪙 USDT Transfer via Smart Wallet on Polygon

A minimal web app built with **React**, **TypeScript**, **Vite**, and **Tailwind CSS** to send **USDT (ERC20)** tokens using **Modular Account V2 smart wallets** directly on the **Polygon** network.

---

## 🧾 License

MIT License – feel free to use, fork, modify, distribute, or sell.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction...
```

---

## 🔐 Security Warning

> ⚠️ **Never expose or reuse a mnemonic phrase from a real wallet on production or shared environments.**

This application is fully client-side and does not store, transmit, or protect your mnemonic phrase in any way. All actions are executed directly in the browser.

You are fully responsible for the security of your own keys and assets. If you choose to use a production wallet or real funds, you do so at your own risk.

This app is intended for testing, development, and educational purposes only. Mnemonics used here should be considered insecure by default.

---

## 📁 Usage

Download the contents of the dist/ folder.

Open index.html in your browser.

The app runs entirely client-side — no server or backend required.

⚠️ Remember, all actions are executed in your browser. You are fully responsible for the security of your mnemonic and funds.

---

## 🚀 Features

- Import a Modular Account V2 smart wallet using **mnemonic phrase**
- View **USDT** and **MATIC** balances of the smart wallet
- Estimate **gas cost** in MATIC before sending
- Send **USDT tokens** via `smartWallet.execute(...)`
- Interact directly with **Polygon RPC**
- Fully client-side — no backend or external services
- Clean Tailwind UI with helpful loading states and error handling

---

## 📦 Tech Stack

- ⚛️ [React](https://react.dev/)
- 🧠 [TypeScript](https://www.typescriptlang.org/)
- ⚡ [Vite](https://vitejs.dev/)
- 🎨 [Tailwind CSS](https://tailwindcss.com/)
- ⛓️ [ethers.js v6](https://docs.ethers.org/v6/)
- 🧩 Smart Wallet (Modular Account) integration

---

## 📂 Project Structure

```
src/
├── App.tsx            # Main component logic
├── main.tsx           # Vite entry point
├── index.html         # HTML shell
├── tailwind.config.ts # Tailwind setup
├── vite.config.ts     # Vite setup
...
```

---

## 🛠️ Installation

> You’ll need **Node.js 18+** and **npm** or **yarn**.

```bash
# Clone the repo or download the source code
cd usdt-transfer-smart-wallet

# Install dependencies
npm install
# or
yarn install
```

---

## 🧪 Development

Run the development server with hot reload:

```bash
npm run dev
# or
yarn dev
```

Then visit: [http://localhost:5173](http://localhost:5173)

---

## 📦 Build Static Files

To generate a static build:

```bash
npm run build
# or
yarn build
```

This outputs the static files to the `dist/` folder.
