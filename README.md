# Stack to the Stars: multiplayer server

Files in this folder: server.js, package.json, render.yaml

Deploy on Render (free):
1. Put these three files in a new GitHub repository (for example "stack-mp-server").
2. On render.com sign in with GitHub, press New, then Web Service, and pick that repository.
3. Settings: Language = Node, Build Command = npm install, Start Command = node server.js, Instance Type = Free.
4. Add an environment variable  ALLOWED_ORIGINS  with the value:
   https://abenezer11y.github.io,https://localhost,http://localhost,capacitor://localhost
5. Press Create Web Service. When it says Live, open  https://YOUR-NAME.onrender.com/health
   You should see {"ok":true,...}
6. Your game server address is the same name with wss:// in front, for example  wss://stack-mp.onrender.com
   Put it in config.js (next to the game's index.html).

Notes
- The free plan sleeps after 15 minutes without traffic and takes about a minute to wake up.
- Rooms live in memory only. If the server restarts, open rooms are lost (nothing else is stored).
- Players only send a nickname, score and tower shape. No accounts, no personal data.
