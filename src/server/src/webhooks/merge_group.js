// SPDX-FileCopyrightText: 2023 SAP SE or an SAP affiliate company and CLA-assistant contributors
//
// SPDX-License-Identifier: Apache-2.0

//////////////////////////////////////////////////////////////////////////////////////////////
// GitHub merge_group Webhook Handler
// We don't actually check the CLA status of merge_group, but rather green light it directly
// For a PR to be in the merge queue the CLA check must have passed on the PR level already
// thus we don't need to check it again during the merge_group
//////////////////////////////////////////////////////////////////////////////////////////////

// services
const CircuitBreaker = require('opossum')
const status = require('../services/status')
const cla = require('../services/cla')
const logger = require('../services/logger')

async function processMergeGroup(args) {
    const item = await cla.getLinkedItem(args)
    let nullCla = !item.gist
    let isExcluded = item.orgId && item.isRepoExcluded && item.isRepoExcluded(args.repo)
    if (!nullCla && !isExcluded) {
        args.token = item.token
        args.gist = item.gist
        if (item.repoId) {
            args.orgId = undefined
        }
        await status.updateForMergeQueue(args)
    }
}

const breaker = new CircuitBreaker(processMergeGroup, {
    timeout: 25000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 3
})
breaker.on('open', () => logger.error('merge_group circuit breaker OPEN'))
breaker.on('halfOpen', () => logger.info('merge_group circuit breaker HALF-OPEN'))
breaker.on('close', () => logger.info('merge_group circuit breaker CLOSED'))

module.exports = {
    accepts: function (req) {
        // Currently merge_group only has `checks_requested`
        // We check anyway to ensure that future adding of more types doesn't impact us
        return ['checks_requested'].indexOf(req.args.action) > -1 && (req.args.repository && req.args.repository.private == false)
    },
    handle: async function (req, res) {
        const args = {
            owner: req.args.repository.owner.login,
            repoId: req.args.repository.id,
            repo: req.args.repository.name,
            sha: req.args.merge_group.head_commit.id
        }
        args.orgId = req.args.organization ? req.args.organization.id : req.args.repository.owner.id
        args.handleDelay = req.args.handleDelay != undefined ? req.args.handleDelay : 1 // needed for unitTests

        try {
            await breaker.fire(args)
            return res.status(200).send('OK')
        } catch (e) {
            logger.error(e)
            return res.status(500).send('Internal Server Error')
        }
    },
    breaker
}
