// Strat roulette: a constraint the whole team plays one round under.
// side: "attack" | "defense" | "any".

export const CHALLENGES = [
  { id: "sheriff-only", side: "any", category: "Loadout", title: "Sheriff squad", text: "Everyone buys a Sheriff and nothing else. Abilities allowed." },
  { id: "shorty-rush", side: "attack", category: "Loadout", title: "Shorty storm", text: "Shorties only. Rush the closest site and plant within 30 seconds." },
  { id: "classic-armor", side: "any", category: "Loadout", title: "Pistols, full armor", text: "Classic only, but everyone buys heavy shields." },
  { id: "snipers", side: "any", category: "Loadout", title: "Long range only", text: "Marshal or Outlaw for everyone. No rifles, no SMGs." },
  { id: "shotgun-hold", side: "defense", category: "Loadout", title: "Close quarters", text: "Shotguns only. Play every angle as close as you can." },
  { id: "one-buy", side: "any", category: "Economy", title: "One wallet", text: "One player buys for the whole team. Everyone else saves." },
  { id: "eco-hero", side: "any", category: "Economy", title: "Hero buy", text: "One player gets a full buy. Everyone else plays pistol and shields." },
  { id: "no-armor", side: "any", category: "Economy", title: "No shields", text: "Full buy on guns, nobody buys armor." },
  { id: "no-abilities", side: "any", category: "Abilities", title: "Pure aim", text: "No abilities this round. Ultimates included." },
  { id: "ults-only", side: "any", category: "Abilities", title: "Ult or nothing", text: "Only ultimates may be used. Save points accordingly." },
  { id: "util-dump", side: "attack", category: "Abilities", title: "Utility dump", text: "Use every ability at the start of the round, then hit a site." },
  { id: "signature-only", side: "any", category: "Abilities", title: "Signature only", text: "Only your free signature ability is allowed." },
  { id: "five-stack", side: "attack", category: "Movement", title: "Conga line", text: "All five walk through the same door together. Nobody leaves the line." },
  { id: "silent-walk", side: "attack", category: "Movement", title: "Ghosts", text: "Shift-walk the entire round, including the plant." },
  { id: "no-crouch", side: "any", category: "Movement", title: "Stand tall", text: "No crouching all round. Jump-peeking is encouraged." },
  { id: "spawn-plant", side: "attack", category: "Plant", title: "Long plant", text: "Plant at the spot farthest from the site entry you used." },
  { id: "last-second", side: "attack", category: "Plant", title: "Buzzer beater", text: "Don't touch a site until the timer reads 0:20." },
  { id: "full-retake", side: "defense", category: "Setup", title: "Give it up", text: "Nobody holds a site. All five wait in spawn and retake together." },
  { id: "stack-one", side: "defense", category: "Setup", title: "All in", text: "Pick one site before the barrier drops. All five stack it." },
  { id: "push-out", side: "defense", category: "Setup", title: "Forward line", text: "Everyone pushes toward attacker spawn when the barrier drops." },
  { id: "one-angle", side: "defense", category: "Setup", title: "Statues", text: "Pick one angle at round start and don't move until you see an enemy." },
  { id: "knives-out", side: "any", category: "Loadout", title: "Knife fight", text: "Knives only until someone on your team gets a kill." },
  { id: "leader", side: "any", category: "Comms", title: "Follow the leader", text: "One player calls everything. Nobody else may speak." },
  { id: "silent", side: "any", category: "Comms", title: "No comms", text: "Total voice silence. Pings only." },
  { id: "compass-calls", side: "any", category: "Comms", title: "Compass calls", text: "Call positions only as north, south, east and west." },
  { id: "reverse", side: "attack", category: "Movement", title: "The long way", text: "Rotate to the site farthest from spawn before hitting it." },
  { id: "drop-guns", side: "any", category: "Economy", title: "Gun swap", text: "Buy a gun, then drop it for the teammate on your right." },
  { id: "odin-ares", side: "any", category: "Loadout", title: "Spray and pray", text: "Ares or Odin for everyone. Hold the trigger." },
  { id: "jump-only", side: "any", category: "Movement", title: "Bunny hop", text: "Jump every time you shoot. No exceptions." },
  { id: "split-five", side: "attack", category: "Setup", title: "Five ways", text: "Everyone takes a different route to the same site." },
  { id: "plant-mid", side: "attack", category: "Plant", title: "Defuser bait", text: "Plant, then everyone leaves the site and plays retake angles." },
  { id: "ninja-defuse", side: "defense", category: "Setup", title: "Ninja defuse", text: "Win the round by defusing, not by killing. Avoid fights where you can." },
];

export function challengesFor(side) {
  return CHALLENGES.filter((c) => c.side === "any" || side === "any" || c.side === side);
}

// Draws one challenge, avoiding the ids in `exclude` until the pool runs out.
export function drawChallenge(rng, side = "any", exclude = []) {
  const pool = challengesFor(side);
  const fresh = pool.filter((c) => !exclude.includes(c.id));
  return rng.pick(fresh.length ? fresh : pool);
}
