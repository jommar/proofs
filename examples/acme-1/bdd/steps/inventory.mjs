import { Given, Then } from '../../fixtures.mjs';

Given('the shopper opens the inventory page', async ({ page, proof }) => {
  const response = await page.goto(process.env.PROOF_APP_URL);
  if (response?.status() !== 200) proof.block('inventory_page_unavailable');
});

Then('the page shows the heading {string}', async ({ page, proof }, heading) => {
  const headingVisible = await page.getByRole('heading', { name: heading, exact: true }).isVisible();
  proof.check(headingVisible, { headingVisible });
});
