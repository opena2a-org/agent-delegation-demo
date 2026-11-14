// Overlay for the atx-conformance fixture generator (scripts/generate-fixtures,
// package main). It is copied into a scratch clone at the pinned commit by
// regenerate.sh and never into the upstream repository.
//
// When DEMO_AGENT_OUT names a directory, init writes the two demo agent
// credentials there, and the two credentials of the verifier lifetime check,
// and exits before the generator's main runs, so no pinned fixture is
// rewritten. The credentials reuse the generator's own builder and signer:
// newBaselineV11ATX, mustLoadKeyVector, mustParseTime, signV11WithKey and
// mustWriteJSONPretty. They are signed under the published test vector
// vectors/issuer-secondary.json, whose issuer DID is under the reserved
// .example domain.
package main

import (
	"os"
	"path/filepath"
)

type demoAgent struct {
	file         string
	id           string
	agentID      string
	capabilities []string
}

func init() {
	out := os.Getenv("DEMO_AGENT_OUT")
	if out == "" {
		return
	}
	outDir = mustResolveOutDir()
	issuer := mustLoadKeyVector("vectors/issuer-secondary.json")
	agents := []demoAgent{
		{"billpay-agent.atx.json", "00000000-0000-4000-8000-0000000000b1", "demo_billpay_agent", []string{"payment:billpay"}},
		{"budget-agent.atx.json", "00000000-0000-4000-8000-0000000000b2", "demo_budget_agent", []string{"payment:read", "payment:billpay"}},
	}
	for _, d := range agents {
		a := newBaselineV11ATX()
		a.ID = d.id
		a.AgentID = d.agentID
		a.AgentDID = "did:opena2a:agent:" + d.agentID
		a.Publisher = "agent-banking-delegation-demo"
		a.PublisherDID = ""
		a.Capabilities = d.capabilities
		a.IssuerDID = issuer.IssuerDID
		a.IssuerChain = []string{issuer.IssuerDID}
		a.Signatures = nil
		a.Signatures = []ATCSignature{signV11WithKey(issuer, a)}
		mustWriteJSONPretty(filepath.Join(out, d.file), a)
	}
	// The verifier lifetime check: two credentials identical except issuedAt,
	// one issued eight days and one issued one day before lifetimeCheckNow,
	// both expiring one day after it. The check runs the verifier with
	// lifetimeCheckNow as its clock; on a real clock both are expired.
	lifetimeCheckNow := mustParseTime("2026-05-23T00:00:00Z")
	checks := []struct {
		file string
		days int
	}{
		{"lifetime-issued-8-days-before.atx.json", 8},
		{"lifetime-issued-1-day-before.atx.json", 1},
	}
	for _, c := range checks {
		a := newBaselineV11ATX()
		a.ID = "00000000-0000-4000-8000-0000000000c1"
		a.AgentID = "demo_lifetime_check_agent"
		a.AgentDID = "did:opena2a:agent:demo_lifetime_check_agent"
		a.Publisher = "agent-banking-delegation-demo"
		a.PublisherDID = ""
		a.Capabilities = []string{"payment:read"}
		a.IssuedAt = lifetimeCheckNow.AddDate(0, 0, -c.days)
		a.ExpiresAt = lifetimeCheckNow.AddDate(0, 0, 1)
		a.IssuerDID = issuer.IssuerDID
		a.IssuerChain = []string{issuer.IssuerDID}
		a.Signatures = nil
		a.Signatures = []ATCSignature{signV11WithKey(issuer, a)}
		mustWriteJSONPretty(filepath.Join(out, c.file), a)
	}
	os.Exit(0)
}
