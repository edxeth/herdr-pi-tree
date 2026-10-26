'use strict';

// Signature fixture for the supported refusal selector's private call site.
// The real, unchanged handler is also exercised in the isolated Pi/Herdr check.
async function chooseRefusalAction(ctx, title) {
  return await ctx.ui.select(title, ['Continue', 'Edit']);
}

module.exports = chooseRefusalAction;
