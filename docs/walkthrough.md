# The walkthrough, screen by screen

The nine screens of the walkthrough in presenter order. Every screen here was captured from this repository at commit 4a5e240, 2026-11-14, on the scripted Example Bank fixture, and the footer of each screen shows the same build. The README embeds three of them, and its section "Check each screen yourself" says how to take them again.

## Overview

![Same agent, same bills, two ways into the bank. This mock bank runs one agent two ways: with the password, and with a grant the bank checks on every payment.](captures/00-overview.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Setup

![The bank sees the customer, or it sees the agent. Path A: The customer. Path B: The agent.](captures/01-setup.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Scenario 1, a normal bill

![A normal bill gets paid either way. Path A: Bill paid. Path B: Bill paid.](captures/02-scenario-1-normal-bill.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Scenario 2, a fake invoice

![With a grant, the bank blocks an unapproved payee. Path A: Paid the fake invoice. Path B: Payment blocked.](captures/03-scenario-2-fake-invoice.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Scenario 3, stopping one agent

![With a grant, the bank stops one agent, not all. Path A: Everyone signed out. Path B: One agent stopped.](captures/04-scenario-3-stop-one-agent.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Scenario 4, a disputed payment

![With a grant, the bank's record names the agent. Path A: No agent on record. Path B: Agent on record.](captures/05-scenario-4-dispute.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Offline check

The image file is `captures/06-offline-check.png`. Its description: With OpenA2A unreachable, the bank still decides. Network open: Four decisions. Network blocked: Same four decisions.

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Summary, opening screen

![What a bank needs before it can say yes. What each path gave the bank in the four scenarios.](captures/07-summary.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.

## Summary, scrolled to the limits

![Where this demo stands. Example Bank is a mock bank.](captures/08-summary-limits.png)

Captured on 2026-11-14 from agent-banking-delegation-demo at commit 4a5e240 against the scripted Example Bank fixture.
