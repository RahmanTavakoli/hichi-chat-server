import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Factory middleware: validates req against a Zod schema.
 * Schema should be shaped as { body?, params?, query? }
 */
export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      const errors = (result.error as ZodError).flatten().fieldErrors;
      res.status(422).json({
        status: 'error',
        message: 'Validation failed',
        errors,
      });
      return;
    }

    // Replace req fields with the coerced + sanitized Zod output
    Object.assign(req, result.data);
    next();
  };
}