import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { HowToUse } from './HowToUse';

it('explains the preparation workflow and current limitations', () => {
  render(<HowToUse />);
  const summary = screen.getByText('How to use AnswerNorth');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(summary);
  for (const heading of ['Choose an agent', 'Prepare tests', 'Save and review']) {
    expect(screen.getByRole('heading', { name: heading })).toBeVisible();
  }
  expect(screen.getByText(/not the viewer’s/)).toBeVisible();
  expect(screen.getByText(/No evaluation can be started/)).toBeVisible();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
