export class RoutingError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RoutingError';
    this.code = 'ROUTING_ERROR';
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends RoutingError {
  constructor(message, errors) {
    super(message, errors);
    this.name = 'ValidationError';
    this.code = 'RULE_VALIDATION_ERROR';
  }
}

export class RuleNotFoundError extends RoutingError {
  constructor(version) {
    super(`Rule package ${version} not found`);
    this.name = 'RuleNotFoundError';
    this.code = 'RULE_NOT_FOUND';
  }
}
