export function Results({ reviewTests, chooseAgent }: { reviewTests: () => void; chooseAgent: () => void }) {
  return <section className="pb-panel pb-results" aria-label="Results">
    <div className="pb-section-title"><h2>No results available</h2></div>
    <p>Evaluation execution and historical evidence reads are not available yet. No results or scores are shown.</p>
    <p>Prepare an agent and a saved test suite now; this does not call the agent or start an evaluation.</p>
    <div className="pb-result-actions"><button className="pb-button pb-primary" onClick={chooseAgent}>Start preparing</button>
      <button className="pb-button" onClick={reviewTests}>Review tests</button></div>
  </section>;
}
