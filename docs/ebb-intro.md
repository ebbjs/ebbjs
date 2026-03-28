👋 Hey friends,

A common trap we all fall into from time to time is working _on_ our tools rather than _with_ our tools.

We research new gadgets, gizmos, implements and instruments – all under the assumption that, "if I just bought _this_, I'd spend more time doing _that_." And if you're cursed with the skills to _make_ your own tools, it gets worse.

That seductive push to _buy_ becomes an opportunity to _build_. Suddenly, you stop writing because you're too busy working on a complicated custom notes app that will make it "so much easier" to write your 1,000 word blog posts.

\*_Sigh_\*

Obviously, I'm speaking from experience. This is exactly what happened to me over my paternity leave. I got caught in the trap.

I spent months working on a document editor that syncs across devices, enables collaborative editing and commenting, _and_ works offline. And what do I have to show for all the time spent productively procrastinating?

Well, experience is what you get when you didn't get what you wanted. And I got a lot of experience.

Turns out, there's a reason essentially every other writing app chooses between working offline and working collaboratively. Providing both is one of the most complicated problems in distributed systems design.

It requires completely rethinking the traditional client-server application architecture, turning your database inside out, and dealing with concurrency and conflicts.

After watching masters level lectures on CRDTs, Merkel trees, broadcast protocols and Lamport Clocks, and frankenstening every existing tool and library together just to _start_ working on the UI of this app, I realized there needed to be a better way for me and people like me to build apps like this.

So, instead of unintentionally falling for the trap of working on my tools, I deliberately decided to build one.

[`ebb` is a framework for building real-time, collaborative, offline-capable apps](https://ebbjs.com/)—the types of apps I want to see more of in the world.

It's a complete rewrite of the architecture I was building for my notes app, but abstracted to help developers focus more on features instead of infrastructure. I'll rebuild it in public and documenting the decisions and learnings along the way in a "devlog".

The first article is already up, and if you're interested in reading about database consistency models, [check it out 😆](https://ebbjs.com/devlog/consistency/).

Until next time,
Drew
