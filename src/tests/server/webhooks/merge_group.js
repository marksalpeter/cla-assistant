// SPDX-FileCopyrightText: 2024 SAP SE or an SAP affiliate company and CLA-assistant contributors
//
// SPDX-License-Identifier: Apache-2.0

/*eslint no-empty-function: "off"*/
// unit test
const assert = require('assert')
const sinon = require('sinon')

// services
const status = require('../../../server/src/services/status')
const cla = require('../../../server/src/services/cla')
const logger = require('../../../server/src/services/logger')

// webhook under test
const webhook = require('../../../server/src/webhooks/merge_group')

function merge_group(req, res) {
    if (webhook.accepts(req)) {
        return webhook.handle(req, res)
    }
}

const testReq = {
    args: {
        action: 'checks_requested',
        repository: {
            owner: { login: 'octocat' },
            id: 1296269,
            name: 'Hello-World',
            private: false
        },
        merge_group: {
            head_commit: { id: 'abc123sha' }
        }
    }
}

describe('webhook merge_group', () => {
    let responseStatus
    const res = {
        status(code) { responseStatus = code; return { send() {} } }
    }

    let testLinkedItem

    beforeEach(() => {
        responseStatus = undefined
        testLinkedItem = { gist: 'https://gist.github.com/test', token: 'token' }

        sinon.stub(cla, 'getLinkedItem').callsFake(async (args) => {
            return Object.assign(args, testLinkedItem)
        })

        sinon.stub(status, 'updateForMergeQueue').resolves()

        sinon.stub(logger, 'error').callsFake((msg) => assert(msg))
        sinon.stub(logger, 'warn').callsFake((msg) => assert(msg))
        sinon.stub(logger, 'info').callsFake((msg) => assert(msg))
    })

    afterEach(() => {
        cla.getLinkedItem.restore()
        status.updateForMergeQueue.restore()
        logger.error.restore()
        logger.warn.restore()
        logger.info.restore()
    })

    describe('accepts', () => {
        it('should accept checks_requested action for a public repo', () => {
            assert.equal(webhook.accepts(testReq), true)
        })

        it('should not accept a private repo', () => {
            const req = { args: Object.assign({}, testReq.args, { repository: Object.assign({}, testReq.args.repository, { private: true }) }) }
            assert.equal(webhook.accepts(req), false)
        })

        it('should not accept non-checks_requested actions', () => {
            const req = { args: Object.assign({}, testReq.args, { action: 'merged' }) }
            assert.equal(webhook.accepts(req), false)
        })
    })

    describe('handle', () => {
        it('should return 200 after successfully updating merge queue status', async () => {
            await merge_group(testReq, res)
            assert.equal(responseStatus, 200)
            assert(status.updateForMergeQueue.called)
        })

        it('should return 500 if getLinkedItem throws', async () => {
            cla.getLinkedItem.restore()
            sinon.stub(cla, 'getLinkedItem').rejects(new Error('DB error'))

            await merge_group(testReq, res)
            assert.equal(responseStatus, 500)
            assert(logger.error.called)
        })

        it('should return 500 if updateForMergeQueue throws', async () => {
            status.updateForMergeQueue.restore()
            sinon.stub(status, 'updateForMergeQueue').rejects(new Error('API error'))

            await merge_group(testReq, res)
            assert.equal(responseStatus, 500)
            assert(logger.error.called)
        })

        it('should return 200 and skip update if nullCla', async () => {
            testLinkedItem.gist = null

            await merge_group(testReq, res)
            assert.equal(responseStatus, 200)
            assert(!status.updateForMergeQueue.called)
        })

        it('should return 200 and skip update if repo is excluded', async () => {
            cla.getLinkedItem.restore()
            sinon.stub(cla, 'getLinkedItem').callsFake(async (args) => {
                return Object.assign(args, testLinkedItem, { orgId: 1, isRepoExcluded: () => true })
            })

            await merge_group(testReq, res)
            assert.equal(responseStatus, 200)
            assert(!status.updateForMergeQueue.called)
        })
    })
})
