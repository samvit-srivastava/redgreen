# RedGreen: tour + live demo script (about 5 min)

Click **▶ Tour** (top right). Use → / Space for next, ← back, Esc to exit.
Speak each block, then press →.

## Part A: the tour (about 3 min)

**1 · No proof, no fix**
"Hi, I'm Samvit, and with Krishna we built RedGreen. Maintainers get issues like 'the total is wrong'. Before anyone can fix it, someone has to reproduce it, and that's the slowest part. AI tools jump to a fix and guess. RedGreen turns the issue into a check that fails on your code. No proof, no fix."

**2 · Red first, green only if you want**
"A reproduction only counts if it fails the way the issue says, on the code as it is. Fixing is optional. A fix only counts when that same check turns green and nothing else breaks."

**3 · How it works**
"A maintainer comments slash redgreen. RedGreen clones the repo and runs the site or its tests. It finds the relevant files with plain keyword search you can see. Gemma 4 reads the issue, the code and a real screenshot, and writes browser steps or a test. Then RedGreen runs it for real."

**4 · Reproduce from the website**
"You can try it right here. Paste any GitHub issue, from a website or a JavaScript project."

**5 · Recent issues**
"Every issue you run shows up here, so you can come back to it."

**6 · RedGreen for GitHub**
"It's also a GitHub App. Anyone can install it on their repos in one click, just like any other GitHub bot. Ours is live on our demo repo."

**7 · Trigger**
"To use it, add the redgreen label or comment slash redgreen. Only people with write access can trigger it, because it runs the repo's code."

**8 · Reproduce only, by default**
"By default it only reproduces. Suggesting a fix and opening pull requests are both off unless you turn them on. It never touches your code without you."

**9 · History**
"Every report and every run is saved, red or green."

**10 · Gemma 4, your way**
"It runs on Gemma 4. By default E4B, locally in LM Studio, so your code never leaves your machine. When deployed, anyone can bring their own Gemma API key and use the bigger Gemma 4 models."

**11 · Prove it**
"Now let me show it live." → press **Finish**.

## Part B: live run (about 2 min)

Before recording: create tiny-shop issue #2 with the text of #1. Do one dry run first.

1. Open tiny-shop issue #2 on GitHub.
   "Here's a real issue. Add Headphones, quantity 3, coupon SAVE20, then quantity back to 1. Expected forty dollars, it shows twenty."
2. Comment `/redgreen`, switch to RedGreen. The run opens by itself.
   "The worker on this laptop picks it up. It clones the repo, serves the site, takes a screenshot, and Gemma 4 writes browser steps. These steps are just data, the model never runs its own code."
3. When it turns red:
   "And it fails. Expected forty, got twenty. The bug is proven on the current code. It also says where to look: app.js, setQuantity."
4. Refresh the GitHub issue, show the bot's comment.
   "And on GitHub the bot posts the proof: the steps, the real output, and where to look."
5. Close:
   "RedGreen. Open source, Apache 2.0, works with any repo. No proof, no fix. Thank you."

If the live run fails on camera, open the dry run from History: "here's the run from earlier."
