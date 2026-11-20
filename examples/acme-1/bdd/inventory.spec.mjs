import { test } from '../fixtures.mjs';

test('A stocked item is available on screen', { tag: '@AC1' }, async ({ page, proof }) => {
  const response = await page.goto(process.env.PROOF_APP_URL);
  if (response?.status() !== 200) proof.block('inventory_page_unavailable');
  const headingVisible = await page.getByRole('heading', { name: 'Available', exact: true }).isVisible();
  proof.check(headingVisible, { headingVisible });
});
