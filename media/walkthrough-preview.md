# Open the Preview 🎨

The Vanguard Preview is where the magic happens. Here's what you'll see:

- **Left panel**: Your Next.js component rendered in real-time
- **Right panel**: Vanguard controls for mutations
- **Overlay**: Click any component to select it

## How it works

1. The preview connects to your local dev server (usually `localhost:3000`)
2. Vanguard injects invisible `v-id` attributes to track components
3. When you click a component, Vanguard highlights it with a blue border
4. That's your signal to describe the mutation!

## Next step

Click "Open Preview" above to launch the preview panel.

💡 **Tip**: Your dev server should be running in another terminal. Vanguard will auto-detect it!
