import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Results } from './Results';

it('shows an honest empty state with preparation navigation only', () => {
  const chooseAgent = vi.fn(); const reviewTests = vi.fn();
  render(<Results chooseAgent={chooseAgent} reviewTests={reviewTests} />);
  expect(screen.getByRole('heading', { name: 'No results available' })).toBeVisible();
  expect(screen.getByText(/historical evidence reads are not available yet/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Start preparing' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review tests' }));
  expect(chooseAgent).toHaveBeenCalledOnce(); expect(reviewTests).toHaveBeenCalledOnce();
});
