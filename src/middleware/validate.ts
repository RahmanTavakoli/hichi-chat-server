import { Request, Response, NextFunction } from 'express';
import { ZodTypeAny } from 'zod';

/**
 * Factory middleware: validates req against a Zod schema.
 * Schema should be shaped as { body?, params?, query? }
 */
export function validate<T extends ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      const errors = result.error.flatten().fieldErrors;

      res.status(422).json({
        status: 'error',
        message: 'Validation failed',
        errors,
      });
      return;
    }

    // ✅ Now fully typed
    const data = result.data as {
      body?: any;
      params?: any;
      query?: any;
    };

    if (data.body) req.body = data.body;
    if (data.params) req.params = data.params;
    if (data.query) Object.assign(req.query, data.query);

    next();
  };
}
