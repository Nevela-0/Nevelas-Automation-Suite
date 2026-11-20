# Nevela’s Automation Suite (PF1E)

Nevela’s Automation Suite is a Foundry VTT module for the **Pathfinder First Edition (PF1E)** system that bundles automation features to streamline gameplay and reduce repetitive bookkeeping.

---

## Requirements

- Foundry VTT v12/v13
- Pathfinder 1st Edition v11.9 or later
- SocketLib module
- LibWrapper

---

## Buff Automation

Automatically applies buffs when spells, consumables, or class features are used.

### Highlights
- For buffs that need a target, **Strict** cancels the use if none are selected. **Lenient** lets you use the item and skips the automatic buff.
- Supports multiple buff compendia including PF1 core and PF-Content
- Smart buff selection system that handles:
  - Exact matches
  - Variants (such as Blessing of Fervor and Evil Eye)
  - Versions (such as Heroism, Greater and Invisibility, Greater)
- Target filtering modes:
  - **By disposition**: Automatically applies buffs to targets with the same disposition as the caster
  - **Manual selection**: Prompts the caster to choose which targets should receive the buff
  - **All targets**: Applies buffs to all targets of the spell/consumable
- Duration handling:
  - Supports caster level-based durations
  - Handles complex duration formulas
  - Proper turn-based duration support
- Buff management:
  - Updates existing buffs instead of stacking
  - Maintains buff duration information
  - Supports custom buff compendia

On the action sheet, check **Buff** to enable automatic application for that action. Use **Choose buffs** to apply one or more buffs to the same targets, or leave it empty to look up the item name. Existing items with the old `buff` flag still work.

### Saves and duration

- An action can apply its buff on a failed save, on a successful save, or without a save. Choose **Any**, **Allies**, or **Enemies** for the recipients. You can also let allies bypass the save.
- A communal spell can divide its duration among several recipients with one spell slot. For abilities with a finite duration that you can use in separate intervals, choose **Non-consecutive** on the action.

### Buffs in the NAS compendium

| Buff | What NAS handles |
|---|---|
| Ablative Barrier | Grants +2 armor AC, converts up to 5 lethal damage per hit to nonlethal, and reduces incoming nonlethal damage by 5. Ends when its pool or duration runs out. |
| Defending Bone | Grants DR 5/bludgeoning until its pool or duration runs out. Bludgeoning bypasses the protection and leaves the pool intact. |
| Firewalker’s Meditation | Tracks DR 5/magic and fire resistance 10 from a shared pool. Apply the save bonus against pain manually. |
| Draconic Reservoir | Absorbs damage of the chosen energy type. Resolve attacks that use the stored energy manually. |

**Mirror Image** also tracks remaining images on the token when cast from a potion, wand, or scroll.

---

## Condition Automation

Adds additional PF1E conditions and automates behavior for many conditions to keep combat moving quickly and consistently.

### Added Conditions
- **Burning**
- **Concealed**
- **Energy Drained**
- **Fascinated**
- **Grappling**
- **Squeezed**

### Sub-Conditions
- **Anchored**: Applies a movement restriction on tokens (immovable)
- **Immobilized**: A sub-condition added by Grappled.
- **Slowed**: Reduces movement speeds by half

These sub-conditions work with other conditions like **entangled**, **grappled**, and more.

### Automated Behaviors (Toggleable Where Noted)
- **Anchored**: With movement restrictions enabled, NAS blocks token movement for Anchored, Cowering, Dazed, Grappled, Helpless, Paralyzed, Petrified and Pinned. The GM can apply restrictions to everyone or just players.
- **Blind**: Moving a token more than half its speed prompts an Acrobatics check—failure results in no movement and the **prone** condition. (Toggleable.)
- **Concealed**: When Concealment is applied, the user will be prompted to select between the normal or total concealment. Currently it supports the Blind-Fight feat.
- **Confused**: Creates a chat message every round showing how affected tokens act. During combat, posts on the affected token’s turn. Includes proper damage application compatibility with damage automation. (Toggleable.)
- **Dead**: With standard HP, a creature reaches the usual death threshold at negative Constitution. For example, a creature with CON 14 reaches it at −14 HP. The setting can also make NPCs die as soon as their HP drops below 0. Enabling NAS death handling turns off automatic defeat in Monk’s Combat Details when applicable.
- **Disabled**: Applied automatically when HP is exactly 0; prompts user decisions for actions and condition changes based on abilities like Diehard. (Toggleable.)
- **Dying**: At negative HP, a dying creature rolls a DC 10 Constitution check on its turn to stabilize. Its current negative HP is applied as a penalty to the roll.
- **Energy Drained**: Automatically applied to tokens with above 0 negative levels. (Toggleable.)
- **Entangled**: Applies **slowed** automatically and prompts concentration checks for spellcasting. (Toggleable.)
- **Fascinated**: Applies a **-4 penalty** on Perception checks.
- **Flat-Footed**: Applied automatically based on initiative rolls, with considerations for abilities like Uncanny Dodge. (Toggleable.)
- **Grappled**: The token is immobile. Prompts concentration checks for spellcasting with somatic components. (Toggleable.)
- **Grappling**: Check **Grapple** in the attack dialog and choose a target. NAS compares the roll to the target’s CMD and applies Grappling to the attacker and Grappled to the defender on a success.
- **Invisible**: Applies Total Concealment automatically as a sub-condition.
- **Nauseated**: Strict handling allows move actions and blocks concentration checks. Lenient handling shows a reminder.
- **Prone**: Applied automatically when certain conditions are met like falling unconscious and blind movement check failure.
- **Slowed**: Sub-condition applied automatically to tokens with conditions like *disabled, entangled, exhausted, and grappling*.
- **Staggered**: Applies when nonlethal damage equals current HP and current HP is above 0.
- **Squeezed / Squeezing**: NAS measures the space between walls. A passage narrower than half the token’s width calls for Escape Artist (DC 30 by default). A gap smaller than its configured head width blocks entry. You can change the widths, DC, and where movement stops after a failed check.
- **Unconscious**: Can apply below 0 HP or when nonlethal damage exceeds current HP. A character with Diehard who chooses to fall unconscious also becomes Stable.

### Surprise Rounds
Surprise Rounds are available only if the **Flat-Footed** setting is enabled.

- Start a surprise round by clicking the **“Surprise Round”** button above **“Begin Combat”**.
- Surprised combatants can remain **Flat-Footed** until their turn in round two. Combatants who act in the surprise round can lose it on their first turn. Abilities such as Uncanny Dodge still apply.
- Before starting combat, use the <span><img src="https://github.com/user-attachments/assets/0f2cb882-8a1e-46c5-8542-5a6fde928bfd" width="23"></span> **Surprised** toggle on the combat tracker to mark the combatants who are surprised. If you use the toggles, unmarked combatants can act. If you use canvas selection instead, select the tokens that can act. **Skip Surprised Tokens** advances past surprised combatants in round one.

---

## Damage Automation

Enhances and streamlines PF1E damage calculation and application by automatically accounting for defenses and damage rules.

### Damage Calculation
- Calculates damage based on the target’s **Damage Reduction (DR)**, **resistances**, **immunities**, and **vulnerabilities**, including logic differences such as spell vs weapon handling.
- Shift-click a damage button to toggle whether the PF1 damage dialog opens.
- **Clustered Shots** is available on ranged weapon cards with at least two attacks when the attacker has the feat. Select the hits to combine before applying DR.
- **Massive Damage Rule** is optional. A single hit dealing at least half the target’s maximum HP (rounded down), with a minimum of 50 damage, triggers a DC 15 Fortitude save.

### Personalized Damage Types

#### Custom Damage Types
When you add a new damage type, you must include:
- **Name**
- **Image/icon** (or icon class)
- **Category**

By default, the system has 3 categories: **Physical**, **Energy**, and **Miscellaneous**, but you can define additional categories.

> *Icon classes* are what the system uses currently (for example, Font Awesome icon class names).

#### Ability Score Damage Types
Each custom damage type can also:
- Target one specific ability score
- Be defined as **ability damage**, **ability drain**, or **ability penalty**

The module supports ability damage immunity. Use the following formats in the damage immunities custom section:

| Immunity Type | Description |
|---|---|
| **Ability Damage** | Immunity to any form of ability damage. |
| **Ability Drain** | Immunity to any form of ability drain. |
| **Ability Penalty** | Immunity to any form of ability penalty. |
| **All Ability Damage** | Complete immunity to any effect that causes ability damage, drain, or penalty. |
| **`Specific Ability` Damage** | Immunity to damage to a specific ability score. |
| **`Specific Ability` Drain** | Immunity to drain of a specific ability score. |
| **`Specific Ability` Penalty** | Immunity to penalties to a specific ability score. |
| **All `Specific Ability` Damage** | Complete immunity to any effect that causes damage, drain, or penalty to a specific ability score. |
| **Mental Ability Damage** | Immunity to damage to any mental ability score (INT, WIS, CHA). |
| **Mental Ability Drain** | Immunity to drain of any mental ability score (INT, WIS, CHA). |
| **Mental Ability Penalty** | Immunity to penalties to any mental ability score (INT, WIS, CHA). |
| **All Mental Abilities** | Complete immunity to any effect that causes damage, drain, or penalty to any mental ability score. |
| **Physical Ability Damage** | Immunity to damage to any physical ability score (STR, DEX, CON). |
| **Physical Ability Drain** | Immunity to drain of any physical ability score (STR, DEX, CON). |
| **Physical Ability Penalty** | Immunity to penalties to any physical ability score (STR, DEX, CON). |
| **All Physical Abilities** | Complete immunity to any effect that causes damage, drain, or penalty to any physical ability score. |

*`Specific Ability` refers to the ability score's full name or abbreviation (e.g., STR, DEX, CON, INT, WIS, CHA) and can be uppercase, lowercase, or capitalized.*

> If you check the damage type's checkbox, both damage and ability damage from this damage type will be nullified.

#### Custom Priority (DR Table)
- Comes with Pathfinder’s default DR priority table
- You can add, remove, and edit rows
- Includes a **Reset to Defaults** button
- An enhancement bonus bypasses the types in its own row and every lower-numbered row.
- Supports system-provided materials/alignments and custom values

---

### Damage Reduction (DR) and Elemental Resistance (ER)
When adding a custom DR or ER type to a token, separate each type by a semicolon (`;`). The module can also handle operators (`and/or`) in the custom section. The amount can be before or after the type.

**Examples**
- `5/Cold Iron and Silver; 10/Glass`
- `Magma or Frost/10; Poison/5`

**DR Magic**
- A weapon with an enhancement bonus greater than 0 counts as magic for bypassing DR/magic.
- If you have a magical weapon lacking enhancement bonuses (such as some natural attacks), check the **magic** checkbox in the attack’s detail tab.

---

### Hardness
Hardness reduces damage from all sources (except ability score damage) by the value entered in the Damage Reduction section of the actor’s sheet.

- **Adamantine**: If hardness is ≤ 20, adamantine bypasses hardness completely.

#### Bypassing Defenses

Items now include:
- **Global Damage Settings**
- **Action Damage Settings**

These let you configure how your damage interacts with:
- **Hardness** (bypass completely or ignore a set amount)
- **Immunities**
- **Resistances**
- **Damage Reduction**

---

### Notes
- **Silver and Alchemical Silver are treated as the same material.** If you add Silver as a custom material, it will not bypass the Silver DR from the system. Add a custom DR with the same name instead.

---

### Damage Roll Cards
When creating a macro or chat damage roll (using `/d` or `/damage`), specify damage types using bracketed flavor after the damage. Include multiple types separated by commas, and you can split types across different dice groups.

**Examples**
- `/d 3d6[Fire, Slashing]`
- `/d 1d8[Acid] + 2d4[Slashing, Piercing] + 5[Negative]`

---

### Alternative Roll Command and Macros

In addition to `/d` and `/damage`, you can use `/as` to roll damage using the Automate Damage dialog UI.

#### Macro Creation
Use `/as macro` to create a new macro. The module opens a dialog to configure formula, damage types, and macro name.

#### Macro API: `ASDamage.roll()`
You can call `ASDamage.roll()` in a macro using either a **string** or **object** syntax:

```js
// Simple usage with a string
ASDamage.roll("type: fire, for: 1d8+5");

// Object format with multiple damage types
ASDamage.roll({
  formula: "1d8+5",
  damageTypes: ["fire", "acid"]
});

// Mixed damage types with string format
ASDamage.roll("1d8 fire + 2d6 acid + 5 bludgeoning");

// Recommended: Component-based approach
ASDamage.roll({
  components: [
    { formula: "1d8", damageTypes: ["fire"] },
    { formula: "2d6+5", damageTypes: ["slashing"] },
    { formula: "10", damageTypes: ["acid"] }
  ]
});
```

This returns a `ChatMessage` and integrates with defenses (DR, hardness, resistances, vulnerabilities, etc.).

---

### Ammunition
For ranged attacks, NAS can read the ammunition’s enhancement through **Roll Bonuses**. Without Roll Bonuses, you can add a **`Magic`** boolean flag to the ammunition to bypass DR/magic.

The legacy damage system also read `Material` and `Alignment` dictionary flags on ammunition. If an arrow has only those flags, they no longer let it bypass the matching DR.

---

### Reactive Effects (On Hit / On Struck)

- On the item sheet (details tab) \ action sheet (action tab) you will find a "On Hit" section with a checkbox for items that have damage actions. Checking it opens configuration that allows you to configure special effects when the attack hits the target (when damage is applied), such as lifesteal or applying a buff or condition to the attacker or the target.
- Similarly, on items such as armor or buffs, you will find a "On Struck" section with a checkbox. Checking it opens configuration that allows you to configure similar effects that happen when that token \ actor is struck.

For example, **Fire Shield** can damage an attacker on a hit and halve the matching energy damage you take. Other damage types in the same hit are resolved separately.

Buffs can also grant defenses or absorb damage from a limited pool. Any damage left over keeps its types for DR, resistance and immunity. For effects that grant **Temporary HP**, you can choose how repeated grants stack and when the pool expires.

---

### Wounds & Vigor

- Enable Wounds & Vigor in PF1’s health settings for the actor and in NAS. On an attack card, use the Vigor/Wounds control to choose where to apply damage. The optional construct and undead house rule gives those creatures Vigor only and destroys them at 0 Vigor.

---

## Metamagic Automation

Adds a metamagic picker to spell dialogs and automatically applies supported metamagic adjustments at cast time—reducing manual edits to spell data, DCs, ranges, and damage formulas.

### Highlights
- Metamagic selection UI on spell dialogs (Attack Dialog → **Metamagic**)
- Pulls available metamagics from the caster’s:
  - **Metamagic feats** (feat tags containing “metamagic”)
  - **Metamagic rods** in inventory (a completed rod cast spends one rod use)
- Smart filtering: only shows metamagics that are **valid for the current spell** (components, range, duration, save, damage, etc.)
- Spontaneous caster support:
  - Automatically consumes the **correct higher-level spell slot**
  - Adjusts casting time according to the **Metamagic Cast Time** setting
- Chat card integration for save-based metamagics:
  - **Persistent Spell** save rerolls are handled from the save button
  - **Dazing Spell** applies **Dazed** on a failed save (with proper turn-based duration)

---

### Supported Metamagics

- **Dazing Spell**
  - Requires a damaging spell.
  - Ensures the spell has a save button (defaults to **Will** only if the spell has no save).
  - On a failed save from the chat card, applies **Dazed** for a number of rounds based on spell level.
- **Empower Spell**
  - Applies 1.5× damage (rounded down) by rewriting damage formulas.
  - Preserves readable roll tooltips for empowered rolls.
- **Enlarge Spell**
  - Doubles close, medium, or long range. The optional **Homebrew Enlarge Spell Numeric Ranges** setting also allows fixed distances.
- **Extend Spell**
  - Doubles duration (excludes concentration, instantaneous, and permanent durations).
- **Heighten Spell**
  - Prompts for a target spell level and updates effective spell level (and DC) accordingly.
- **Intensified Spell**
  - Increases common caster-level-based damage caps by **+5** (up to caster level), where applicable.
- **Maximize Spell**
  - Converts damage dice into maximum results by rewriting dice expressions.
- **Persistent Spell**
  - Adds a reminder footnote and upgrades the chat save workflow:
    - On a successful save, automatically rolls the **second** save.
- **Reach Spell**
  - Steps range upward (**Touch → Close → Medium → Long**).
  - Prompts you to choose how many steps to apply. A ranged touch attack still targets touch AC.
  - Converts melee spell attacks (**msak**) to ranged spell attacks (**rsak**) when applicable.
- **Selective Spell**
  - For **instantaneous area** spells, prompts you to exclude targets.
  - Choose exclusions from the template or from manually selected targets. Your spellcasting ability modifier limits how many you can exclude. Canceling keeps the spell slot and removes the newly placed template.
- **Silent Spell**
  - Removes verbal components. NAS skips Silent Spell if Bard appears on the spell’s class list.
- **Still Spell**
  - Removes somatic components.
- **Quicken Spell**
  - Sets casting time to **swift**.
- **Widen Spell**
  - Doubles eligible bursts, emanations, spreads, and lines for a +3 slot adjustment. A widened line stops at the spell’s range. The chat card shows the resulting area.

---

### Supported class features, feats and traits

- Arcane Apotheosis
- Arcane Bloodline
- Arcane Prodigy (Drow)
- Curator of Mystic Secrets
- Eldritch Researcher
- Extended Scrying
- Grand Maestro
- Healer's Blessing
- Intense Celebration
- Magical Lineage
- Maleficium
- Mask Focus
- Metamagic Adept
- Metamagic Mastery
- Metamixing
- Mimic Metamagic
- Nanite Bloodline
- One Body, Two Minds
- Peerless Speed
- Prolong Magic (Tiefling)
- Retribution
- Seeker of the Eternal Emperor
- Spell Perfection
- Spontaneous Metafocus
- Succor Final Revelation
- Timeless Soul
- Transmuter of Korada
- Wayang Spellhunter (Minata)

---

### Usage
- Open a spell’s use dialog.
- Enable **Metamagic**.
- Select one or more metamagics from the dropdown.
- Some metamagics prompt for extra info:
  - **Reach Spell**: choose range steps
  - **Heighten Spell**: choose target spell level
  - **Selective Spell**: choose which targets to exclude

---

### Settings
- **Metamagic Cast Time**
  - Controls how metamagic affects **spontaneous** casting time.
- **Metamagic Preview Display** and **Metamagic Chat Card Name** control the cast preview and how the spell is named in chat.

---

## Spellbook Preparation

With **Enable Metamagic Automation** and **Full spellbook preparation** enabled, open **Prepare this spellbook** on the actor sheet. Prepared and hybrid spellbooks are supported, including separate domain slots. **Metamagic variants only** keeps prepared variants available without the full book. **Classic / off** uses the ordinary PF1 preparation workflow.

### Preparing spells

1. Choose **Copy spells from sheet** to bring the actor’s spells into the book, or **Start empty** to begin with an empty list. Both keep the actor’s original spells and existing preparation. Use **Add missing spells** for spells you learn later.
2. Use the bookmarks or search to find a spell. Set its prepared count, or click the quill to inscribe a metamagic copy. Click the quill again to close it. The book shows the slot the copy will use. Its save DC uses the original spell level unless Heighten Spell changes it.
3. Click **Prepare spells** to save your spell choices. **Random preparation** chooses spells within your limits for you to review. **Remove from spellbook** removes the selected spell when you prepare spells. **Remove inscription** removes only its metamagic copy. The original spell stays on your sheet.

### Managing a book and resting

- Open **Manage this spellbook** on the inside cover. Turning off **Use NAS for this spellbook** restores PF1 preparation and sets the NAS copies aside for later. **Hide Source Spellbook Spells** hides original rows in managed books. The originals stay on the actor.
- Under **After resting**, choose **Prepare the same spells again** to restore uses after rest, **Choose again** to pick new spells, or **Prepare randomly**. **Use module setting** follows the world default. This applies when the rest restores daily uses and **Prepare Spellbook** is checked.
- **Save options** saves the management and rest choices for this book. Use **Prepare spells** for changes to spells. Turning off the module’s metamagic setting keeps your saved preferences.
- In your personal settings you can show the actor-sheet button, open books that need preparation after a rest, or change page motion. **Page motion** is also on the inside cover and respects your reduced-motion preference.

---

## Combat Action Tracker

The tracker is off by default. In **Configure Settings → NAS → Action Tracker**, turn on **Enable Action Tracker Interface** to show counters beside combatants. They show actions used this turn. Open the manual controls to record an action, or enable **Automatic Action Tracking** to record completed PF1 item uses. Both the standard and unchained action economies are supported.

### Movement and history

- **Enable Movement Tracking** records distance and elevation on the combatant’s own turn. Turn on **Automatic Movement Spending** to count actions from movement and speed. Split drags can share a movement allowance. The tracker lets you move beyond it.
- You can declare a 5-foot step, Run, Charge, Withdraw, or a Spring Attack. Check the route and the activity’s requirements yourself. In the standard action economy, use PF1’s **Charge** checkbox for the attack. Spring Attack applies the included attack penalties. Resolve attacks of opportunity manually, and spend any declared mythic power on the actor.
- Owners and GMs can use **History** to correct a record or undo a recorded action. This changes tracked usage and distance only. The token stays in place, rolls stand, and spent resources stay spent.
- **Action Counter Visibility** controls whose counters appear in the tracker. Only owners and GMs can open detailed history or make changes there. Foundry document and API permissions still apply. You can hide free actions and nonactions from your counters and still record them manually.
- On v12, **Show Starting-Position Marker** shows owners and GMs where the combatant started until its next turn. It requires movement tracking. On v13, Foundry provides the ruler.
- If you switch from the original **PF1 Action Tracker**, disable it in **Manage Modules**. Leaving both enabled records actions in both trackers.

### Region movement presets (v13)

Open a Region’s **Modify Movement Cost** behavior and choose a **Terrain movement cost**.

- **Difficult Terrain ×2** doubles the cost of walking.
- **Heavy Undergrowth ×4** makes walking cost four times as much.
- Both presets set Fly, Swim, and Burrow to ×1. Choose **None** to keep the current slider values.

You can adjust the sliders before clicking **Update Region Behavior** to save. Where Regions overlap, their movement costs multiply. These presets set movement costs only. Handle concealment, skill checks, conditions, and movement restrictions separately.

---

## Quality of Life

### On Card Save

- Click the save button on an action card to roll for the tokens you have selected on the canvas. With no selection, NAS uses the targets saved on the card. Persistent Spell rerolls a successful save, and Dazing Spell and save-based buffs use the DC accepted in the save dialog.
- Enable the token icon on save messages to tell identical NPCs apart. **Hide Private Save Outcomes from Players** hides the success or failure text for saves whispered to the GM.

### Enhanced Dice Tooltips

- This setting changes how the system shows unlabeled modifiers in the roll tooltips. When certain variables are available (such as caster level), it will show that bonus and label them appropriately. If a bonus is added but the module could not label it, it will be labeled as "bonus".

### Combat Text

- Choose **Enhanced** or **Cinematic** to change how floating health changes appear. Cinematic mode also lets you choose the movement style.

### Enforce Spell Ability Minimum

- Requires a casting ability score of 10 + spell level to cast or assign a spell, and hides levels above that limit on the actor sheet. Spellbooks marked with **No Ability Limit** are exempt.

---

## Installation
In Foundry’s **Install Module** window, paste the manifest URL below. Enable the suite and its required modules in your world. If you used **PF1 Automate Damage** or **PF1 Improved Conditions**, disable those predecessor modules so NAS can start. The legacy migration tool is available in module settings.

**Manifest URL:** https://github.com/Nevela-0/Nevelas-Automation-Suite/releases/latest/download/module.json

---

## Usage
Once installed and enabled, configure which automations you want active in the module’s settings.

---

## License
This suite includes components licensed under different terms:

- Damage Automation components are licensed under the **MIT License** (see included LICENSE file).
- Condition/Buff components include content covered under the **Open Game License (OGL)** (see `ogl.md`).

---

## Credits
- **Nevela**: Lead developer and creator.
- **Mana (MKAh)** created [Action Tracker for Pathfinder 1e](https://gitlab.com/mkahvi/fvtt-micro-modules/-/tree/master/pf1-action-tracker). Thank you for letting us integrate it into NAS. The original module is no longer maintained or supported for Foundry v13 and later.
- **Contributors**: PF1E system and module developers for their support.
- **Claudekennilol**: Huge general support with compatibility and module settings.
- **[McGreger](https://github.com/McGreger)**: Help with German localization.
- **Condition Icons**: Icons selected from [game-icons.net](https://game-icons.net/about.html).

---

## OGL
This module includes content covered under the Open Game License (OGL). For more details, please refer to the [OGL license](./ogl.md).
