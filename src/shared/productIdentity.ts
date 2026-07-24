import identity from './productIdentity.json'

export const PRODUCT_IDENTITY = Object.freeze(identity)

export const PRODUCT_REPOSITORY_URL = `https://github.com/${identity.repositoryOwner}/${identity.repositoryName}`
