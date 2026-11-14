// The agent's decision about what to pay. The same code runs on both paths;
// the way the agent reaches the bank is the one difference.
//
// Scripted injected instruction: a hidden line in an invoice that starts with
// "Assistant:" is followed, the way a language model can follow text planted
// in its input. This demo calls no language model; the effect is scripted.

export function planInvoicePayment(invoice) {
  let payTo = { name: invoice.payTo.name, account: invoice.payTo.account };
  let followedHiddenInstruction = false;
  const hidden = invoice.hidden;
  if (hidden && typeof hidden.text === 'string' && hidden.text.startsWith('Assistant:') && hidden.payToAccount) {
    payTo = { name: invoice.payTo.name, account: hidden.payToAccount };
    followedHiddenInstruction = true;
  }
  return {
    attempt: {
      kind: 'payment',
      invoiceId: invoice.invoiceId,
      payeeName: payTo.name,
      payeeAccount: payTo.account,
      amount: invoice.amount,
      currency: invoice.currency,
    },
    followedHiddenInstruction,
  };
}
