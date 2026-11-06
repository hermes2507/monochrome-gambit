# Monochrome Gambit

**A bluffing chess variant: every piece looks the same, and each one secretly belongs to someone.**

▶ **Play it:** https://hermes2507.github.io/monochrome-gambit/

All 32 pieces are carved from the same bone. At the start, ownership is dealt at random between ☀ Sol and ☾ Luna, and each player secretly knows only *some* of their own pieces. Anyone may move any piece. Moving one that isn't yours is a bluff, and your rival can **Dispute** it.

- **Dispute is right:** the move is undone and the bluffer loses a turn.
- **Dispute is wrong:** the disputer loses a turn.
- Capture the rival's **king** to win.

A shared 40-card deck, presented with a nod to Balatro, adds Counter-disputes, Alibis, Turncoats, colour Frosts and Purges.

## Modes

| Mode | How |
|---|---|
| **vs AI** | Play against Luna, a heuristic opponent that bluffs and disputes based on probabilities. |
| **Hotseat** | Two players on one device, with "pass the device" screens that hide each player's secrets. |
| **Online** | One player hosts and gets a 5-letter code (and an invite link); the friend types it in. |
| **Chess960** | Optional for every mode: the back rank is shuffled each game. |

## Rules in brief

1. **Draw** a card (hand limit 6), optionally play **one action card**, then **move any piece** with normal chess movement.
2. Any piece may capture any piece. There is no check, castling or en passant. Pawns promote to queens.
3. Both kings are public, and only a king's owner may move it.
4. A piece's owner is revealed to everyone when it is captured or disputed.
5. Each non-king piece also wears a public **colour** (red, white or plain). Colour is unrelated to ownership. It's what Frost, Purge, Shuffle and Paintbrush act on.
6. The default back rank, the **Monochrome setup**, is `R B Q N K N B R`. It isn't the classic `R N B Q K B N R` on purpose: since any piece can capture any piece, a queen beside the king could capture it on move one, so knights guard the kings instead. The Chess960 option only deals positions without a queen or rook next to the king (172 of the 960).

The full rules and the card list are in the in-game **Rules** screen.

## How online play works

Online games are **peer-to-peer** using WebRTC through [PeerJS](https://peerjs.com). There is no game server.

- The free PeerJS cloud server only introduces the two browsers. The room code is part of the host's peer ID.
- The **host's browser runs the game engine** and holds the full state. After every change it sends the guest a *filtered view* with only what the guest is allowed to see. The guest sends back intentions (a move, a card, an answer), and the host validates each one.
- If a direct connection isn't possible, PeerJS's public TURN relay servers are used as a fallback.

Limitations, by design of the cheapest setup:

- **The host could cheat** by inspecting their own browser's memory. Play with friends you trust.
- If the **guest** disconnects, they can rejoin with the same code or link. If the **host** closes or reloads the page, the game ends.
- Online play depends on PeerJS's free public servers being available.

## Run locally

It's three static files with no build step. Open `index.html` directly, or serve the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Project structure

```
index.html   page layout
style.css    styles (pixel/CRT look)
game.js      rules engine, AI, rendering
net.js       online play (PeerJS), menus, About screen
```

## Credits & attributions

- **Game concept and design direction:** Santiago Rentería ([@hermes2507](https://github.com/hermes2507)).
- **Code** written with [Claude Code](https://claude.com/claude-code) (Anthropic).
- **Chess**, and **Chess960 / Fischer Random Chess** devised by Bobby Fischer, are the foundation of the variant.
- The card presentation is **inspired by [Balatro](https://www.playbalatro.com/)** by LocalThunk. This project is not affiliated with or endorsed by Balatro's creators and uses none of its assets.
- [**PeerJS**](https://github.com/peers/peerjs) 1.5.5, MIT License, loaded from the unpkg CDN. Also the PeerJS cloud signalling server and public TURN servers.
- Google's public STUN server (`stun.l.google.com`), used by PeerJS by default.
- Fonts from Google Fonts, under the [SIL Open Font License 1.1](https://openfontlicense.org):
  - [**Silkscreen**](https://fonts.google.com/specimen/Silkscreen) by Jason Kottke
  - [**Pixelify Sans**](https://fonts.google.com/specimen/Pixelify+Sans) by Stefie Justprince
- Chess pieces are standard Unicode chess symbols drawn by the device's fonts.

## License

[MIT](LICENSE) © 2026 Santiago Rentería
