// Where a SQL Server runs (Linux or Windows, in a container or not), as
// reported by sys.dm_os_host_info and sys.dm_os_sys_info.container_type_desc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf } from '../../src/sql/inspect.js';
import { platformOf } from '../../public/views/servers.js';

const row = (over) => ({ host_platform: 'Linux', host_distribution: 'Ubuntu', host_release: '24.04', container_type: 'LINUX CONTAINER', ...over });

test('the host as SQL Server reports it', () => {
    assert.deepEqual(hostOf(row({})), { platform: 'Linux', distribution: 'Ubuntu', release: '24.04', container: 'LINUX CONTAINER' });
    assert.equal(hostOf(row({ container_type: 'NONE' })).container, null, 'NONE: not in a container');
    assert.deepEqual(hostOf({}), { platform: null, distribution: null, release: null, container: null }, 'an older version that cannot say');
});

test('as a short tag and a longer description', () => {
    assert.deepEqual(platformOf(hostOf(row({}))), { short: 'Linux container', long: 'Ubuntu 24.04, in a container (Docker, Kubernetes or similar)' });
    assert.deepEqual(platformOf(hostOf(row({ container_type: 'NONE', host_distribution: 'Red Hat Enterprise Linux', host_release: '9.4' }))), {
        short: 'Linux',
        long: 'Red Hat Enterprise Linux 9.4, not in a container',
    });
    const windows = hostOf({ host_platform: 'Windows', host_distribution: 'Windows Server 2022 Standard', host_release: '10.0', container_type: 'NONE' });
    assert.deepEqual(platformOf(windows), { short: 'Windows', long: 'Windows Server 2022 Standard, not in a container' });
    assert.equal(platformOf(null), null, 'never reached: nothing to show');
    assert.equal(platformOf(hostOf({})), null);
});
