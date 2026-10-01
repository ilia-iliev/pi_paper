I'd like some way of reading papers. Basically, the flow should be like that:

1. I type `pi_paper "link_to_arxiv"`
2. the arxiv link opens, with images rendered
3. I can scroll up/down with pagedown/up by a fixed amount, half a page
4. I can scroll the agent convo with ctrl+pageup/down
4. There are zoom presets for the pdf only - 50%, 75%, 100%, 125% ... (in increments by 25%, allt he way to 250%), controllable by ctrl and +/-
4. There's a prompt box in the bottom
5. When I type something in the bottom, the rendered section of the pdf is sent to an active agent with my question. For example, I could ask "explain this graph, I struggle to understand why it's important". The answer should render in a dedicated place.
6. It flows like a convo. I can do /clear to clear the previous question
7. We target foot and sixel


It's basically a wrapper around pi with some prompt like "you help the user read a paper yada yada". 

   ┌──────────────────────────┬──────────────────┐
   │                          │ Conversation     │
   │         PDF              │                  │
   │                          │ You: Explain…    │
   │                          │ Agent: …         │
   ├──────────────────────────┴──────────────────┤
   │ Ask about what you're looking at…           │
   └─────────────────────────────────────────────┘