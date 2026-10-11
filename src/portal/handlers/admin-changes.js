export const adminChangesHandler = {
  async status(coordinator, changeId, send) {
    const status = await coordinator.getStatus(changeId);
    return send(200, status);
  },

  async forceCommit(coordinator, changeId, send) {
    const result = await coordinator.commit(changeId);
    return send(200, { changeId, ...result });
  },

  async abort(coordinator, changeId, body, send) {
    const reason = body?.reason || 'operator';
    const result = await coordinator.abort(changeId, reason);
    return send(200, { changeId, reason, ...result });
  }
};
