'use strict';

function memoryQueue() {
  const state = { items: [], calls: [], fail: false, nextId: 0 };
  state.clientFactory = async () => ({
    async list() { return state.items.map(item => ({ ...item })); },
    async add(thread, text, clientUserMessageId) {
      if (state.fail) throw new Error('Queue temporarily unavailable');
      const item = { id: `q-${++state.nextId}`, clientUserMessageId, input: [{ type: 'text', text, text_elements: [] }] };
      state.items.push(item);
      state.calls.push({ method: 'add', id: item.id });
      return item;
    },
    async update(thread, id, text) {
      const item = state.items.find(entry => entry.id === id);
      if (!item) throw new Error('Queued item no longer exists');
      item.input = [{ type: 'text', text, text_elements: [] }];
      state.calls.push({ method: 'update', id });
      return {};
    },
    async remove(thread, id) {
      const index = state.items.findIndex(entry => entry.id === id);
      if (index < 0) return { deleted: false };
      state.items.splice(index, 1);
      state.calls.push({ method: 'delete', id });
      return { deleted: true };
    },
    close() {},
  });
  return state;
}

module.exports = { memoryQueue };
