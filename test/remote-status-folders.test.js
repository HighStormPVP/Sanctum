// What a status from the connection manager does to the folders chats keep for each laptop, on the
// real code from renderer.js (see e2e/mirror-sim.js). Only a list that can be trusted to be whole
// drops a removed laptop's folder, and one from a manager that has shut down, while quitting, isn't.
const test = require('node:test');
const assert = require('node:assert');
const { startSim } = require('../e2e/mirror-sim.js');

const whole = (devices) => ({ name: 'Home', enabled: true, stopped: false, locked: false, storageAvailable: true, devices });
const LAPTOP = { id: 'L', role: 'laptop', connected: true };

function homeWithFolder() {
  const sim = startSim({ mbit: 20 });
  sim.addChat('c1', 0, { modality: 'agent', projectFolders: { L: '/work' }, pathAllowlists: { L: ['/work'] } });
  sim.home.mirrorOnStatus(whole([LAPTOP]));
  return sim;
}

const folders = (sim) => ({ ...sim.home.state.chats.c1.projectFolders });

test('a laptop gone from a whole list loses its folder', () => {
  const sim = homeWithFolder();
  sim.home.mirrorOnStatus(whole([]));
  assert.deepEqual(folders(sim), {});
});

test('after shutdown, a status refresh drops no folder', () => {
  // As the manager says it now: stopped, and so not on.
  const sim = homeWithFolder();
  sim.home.mirrorOnStatus({ ...whole([]), enabled: false, stopped: true });
  assert.deepEqual(folders(sim), { L: '/work' });

  // And the page doesn't take an empty list from a stopped manager as whole, whatever else it says.
  const other = homeWithFolder();
  other.home.mirrorOnStatus({ ...whole([]), stopped: true });
  assert.deepEqual(folders(other), { L: '/work' });
  assert.deepEqual({ ...other.home.state.chats.c1.pathAllowlists }, { L: ['/work'] });
});
