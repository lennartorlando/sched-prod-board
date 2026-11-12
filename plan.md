# sched-prod incident board — plan

The on-call board for sched-prod. One page, one list: tonight's incidents, newest first, so on-call sees
what just broke and takes it.

## Flows

| flow | who | what happens |
|------|-----|--------------|
| `open-board` | on-call | opens the board; sees tonight's incidents |
| `ack-incident` | on-call | picks an incident on the board and acks it — "I've got this one" |
| `watch-board` | on-call | keeps the board open; it stays current without a reload |

## Requirements

- **R1** New incidents appear live at the top of the list, newest first.
- **R2** Each incident row has an **Ack** button. Ack opens a confirm that names the incident id and sends nothing. The confirm's Ack (`confirm-ack`) sends the ack (`api.ack(id)`) for the id it names and marks that row acked; its Cancel (`confirm-cancel`) or Escape closes it and sends nothing. *(Changed in step two: product decided that Ack asks to confirm and the confirm names the incident id.)*
- **R3** Show a loader until incidents load.
- **R4** The board refreshes itself every 2 seconds while open.
- **R5** Times show in the viewer's local time; day before month for EU locales (dd/mm).
- **R6** The page names its build: `<meta name="build" content="<git sha>">` in the head and the same sha in the footer.
- **R7** The confirm is a bar fixed at the bottom of the screen. It shows the incident id, severity, service, region and summary, and the row it names is outlined. New incidents keep arriving at the top while it is open; the bar does not move, so its Ack always acks the incident it names. *(Added in step two.)*

## Hooks (pinned — tests and the replay rely on them)

| `data-testid` | element |
|---------------|---------|
| `board` | the board's main area |
| `loader` | the loader (gone once incidents load) |
| `empty` | what shows when there are no incidents |
| `incident-list` | the list |
| `incident-row` | one incident row, with `data-id="<incident id>"` |
| `ack` | the Ack button in a row |
| `acked` | the acked mark in a row |
| `build-sha` | the sha in the footer |
| `confirm` | the confirm, naming the incident id (hidden while closed) |
| `confirm-ack` | the confirm's Ack: acks the incident the confirm names |
| `confirm-cancel` | the confirm's Cancel: closes it, sends nothing |

## Done

Every issue in `issues/` delivered, deployed to a public https address, and shown working.
