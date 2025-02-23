'use strict';

const randomstring = require('randomstring');
const chalk = require('chalk');
const fs = require('fs');
const https = require('https');
const proxy = require('proxy-agent');

class CloudfrontInvalidate {
	constructor(serverless, options) {
		this.serverless = serverless;
		this.options = options || {};
		this.proxyURL =
			process.env.proxy ||
			process.env.HTTP_PROXY ||
			process.env.http_proxy ||
			process.env.HTTPS_PROXY ||
			process.env.https_proxy;
		this.provider = 'aws';
		this.aws = this.serverless.getProvider('aws');

		if (this.proxyURL) {
			this.setProxy(this.proxyURL);
		}

		if (this.options.cacert) {
			this.handleCaCert(this.options.cacert);
		}

		this.commands = {
			cloudfrontInvalidate: {
				usage: 'Invalidate Cloudfront Cache',
				lifecycleEvents: ['invalidate'],
			},
		};

		this.hooks = {
			'cloudfrontInvalidate:invalidate': this.invalidate.bind(this),
			'after:deploy:deploy': this.afterDeploy.bind(this),
		};
	}

	setProxy(proxyURL) {
		this.aws.sdk.config.update({
			httpOptions: { agent: proxy(proxyURL) },
		});
	}

	handleCaCert(caCert) {
		const cli = this.serverless.cli;

		if (!fs.existsSync(caCert)) {
			throw new Error('Supplied cacert option to a file that does not exist: ' + caCert);
		}

		this.aws.sdk.config.update({
			httpOptions: { agent: new https.Agent({ ca: fs.readFileSync(caCert) }) },
		});

		cli.consoleLog(`CloudfrontInvalidate: ${chalk.yellow('ca cert handling enabled')}`);
	}

	// Add a delay helper method
	delay(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	createInvalidation(distributionId, reference, cloudfrontInvalidate) {
		const cli = this.serverless.cli;
		const cloudfrontInvalidateItems = cloudfrontInvalidate.items;

		const params = {
			DistributionId: distributionId /* required */,
			InvalidationBatch: {
				/* required */ CallerReference: reference /* required */,
				Paths: {
					/* required */ Quantity: cloudfrontInvalidateItems.length /* required */,
					Items: cloudfrontInvalidateItems,
				},
			},
		};
		return this.aws.request('CloudFront', 'createInvalidation', params).then(
			() => {
				cli.consoleLog(`CloudfrontInvalidate: ${chalk.yellow('Invalidation started')}`);
			},
			(err) => {
				cli.consoleLog(JSON.stringify(err));
				cli.consoleLog(`CloudfrontInvalidate: ${chalk.yellow('Invalidation failed')}`);
				throw err;
			}
		);
	}

	// Modified invalidateElements to add a 1000ms delay between invalidation calls
	async invalidateElements(elements) {
		const cli = this.serverless.cli;

		if (this.options.noDeploy) {
			cli.consoleLog('skipping invalidation due to noDeploy option');
			return;
		}

		for (const element of elements) {
			let cloudfrontInvalidate = element;
			let reference = randomstring.generate(16);
			let distributionId = cloudfrontInvalidate.distributionId;
			const containsOriginArray =
				typeof cloudfrontInvalidate.containsOrigin === 'string'
					? cloudfrontInvalidate.containsOrigin.split(',')
					: [];
			let stage = cloudfrontInvalidate.stage;

			if (stage !== undefined && stage !== `${this.serverless.service.provider.stage}`) {
				continue;
			}

			if (distributionId) {
				cli.consoleLog(`DistributionId: ${chalk.yellow(distributionId)}`);
				try {
					await this.createInvalidation(distributionId, reference, cloudfrontInvalidate);
				} catch (e) {
					// error is logged in createInvalidation
				}
				await this.delay(1000);
				continue;
			}

			if (containsOriginArray.length > 0) {
				cli.consoleLog(`containsOriginArray: ${chalk.yellow(containsOriginArray)}`);
				try {
					const data = await this.aws.request('CloudFront', 'listDistributions');
					const distributions = data.DistributionList.Items;
					for (const distribution of distributions) {
						const foundDistribution = distribution.Origins.Items.find((origin) =>
							containsOriginArray.includes(origin.DomainName)
						);
						if (foundDistribution) {
							cli.consoleLog(
								`Going to invalidate distributionId: ${chalk.yellow(distribution.Id)}`
							);
							await this.createInvalidation(distribution.Id, reference, cloudfrontInvalidate);
							await this.delay(1000);
						}
					}
				} catch (err) {
					cli.consoleLog(JSON.stringify(err));
				}
				continue;
			}

			if (!cloudfrontInvalidate.distributionIdKey) {
				cli.consoleLog('distributionId, containsOrigin or distributionIdKey is required');
				continue;
			}

			cli.consoleLog(
				`DistributionIdKey: ${chalk.yellow(cloudfrontInvalidate.distributionIdKey)}`
			);

			const stackName = this.serverless.getProvider('aws').naming.getStackName();

			try {
				const result = await this.aws.request('CloudFormation', 'describeStacks', {
					StackName: stackName,
				});
				if (result) {
					const outputs = result.Stacks[0].Outputs;
					for (const output of outputs) {
						if (output.OutputKey === cloudfrontInvalidate.distributionIdKey) {
							distributionId = output.OutputValue;
							break;
						}
					}
				}
				await this.createInvalidation(distributionId, reference, cloudfrontInvalidate);
				await this.delay(1000);
			} catch (e) {
				cli.consoleLog(
					'Failed to get DistributionId from stack output. Please check your serverless template.'
				);
			}
		}
	}


	afterDeploy() {
		const elementsToInvalidate = this.serverless.service.custom.cloudfrontInvalidate.filter(
			(element) => {
				if (element.autoInvalidate !== false) {
					return true;
				}

				this.serverless.cli.consoleLog(
					`Will skip invalidation for the distributionId "${
						element.distributionId || element.distributionIdKey
					}" as autoInvalidate is set to false.`
				);
				return false;
			}
		);

		return this.invalidateElements(elementsToInvalidate);
	}

	invalidate() {
		return this.invalidateElements(this.serverless.service.custom.cloudfrontInvalidate);
	}
}

module.exports = CloudfrontInvalidate;
