# Dink Club

Pickleball on your TV — your phone is the paddle.

Open the game on a TV or laptop browser, scan the QR code with your phone, and swing it like a paddle.
Timing aims the ball (early pulls it across, late pushes it), soft swings dink, hard swings drive, swinging upward lobs.
Movement is automatic. Play the computer at four levels, or two phones head to head.

- Three.js + postprocessing, Vite, TypeScript
- Phones connect over WebRTC (PeerJS); `pad.html` reads the gyroscope and sends each swing at its peak
- Players: Microsoft Rocketbox avatars (MIT) with procedural strokes; sky: Poly Haven HDRIs (CC0)
- Paddle art, banners, logo, palm frond and sounds generated with Higgsfield

`npm run dev` → http://localhost:5230 · tests: `node tools/autoplay.mjs`, `node tools/phonetest.mjs`
